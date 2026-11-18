'use strict';
/*
 * A live source for the price ceilings (issue #16).
 *
 * What hashrate is worth moves with the coin's price and every difficulty retarget, so a fixed
 * ceiling is either too loose or too tight most of the day. When guardrails.ceiling_source_url is
 * set, Pickhash reads it each engine tick and uses what it says in place of the stored ceilings:
 *
 *   { "blended_ceiling_sats_unit_day": 6630.4,   // required, sats per <priceUnit> per day
 *     "rate_ceiling_sats_th_hour": 276.27,        // optional, sats per TH per hour
 *     "as_of": 1791103808,                        // required, unix seconds
 *     "algo": "blake2b", "price_unit": "th" }     // optional; checked against the algorithm when sent
 *
 * It is a money control, so it fails CLOSED. A feed that is unreachable, unreadable, an error
 * status, missing a required field, or older than guardrails.ceiling_source_max_age_s counts as a
 * ceiling of 0 (any failed read clears the last reading at once), and
 * autopilot and auto-extend rent and extend nothing until it is good again. Nothing is cancelled:
 * running rentals run out as they would.
 *
 * The stored ceilings the user set by hand stay the upper limits: the feed can tighten them,
 * never loosen them. A compromised or buggy feed can then stop spending but cannot raise it past
 * them. With none set it is bounded only by the market price limit and the budgets, and the
 * status says so.
 *
 * State is in memory, keyed by algorithm and URL, because the engine and the API run in one
 * process. A restart starts with no reading, which fails closed until the first tick reads the feed.
 */
const config = require('./config');
const market = require('./market');
const algos = require('./algos');

const FETCH_TIMEOUT_MS = 4000;          // a slow feed must not hold up the engine tick
const MAX_BODY_BYTES = 64 * 1024;
const FUTURE_SKEW_S = 300;              // an as_of further ahead than this is a broken clock or a ms value

const state = new Map();   // `${algo} ${url}` -> { good: {blended, rate, asOf, fetchedAt} | null, error, attemptedAt }

function keyOf(algo, url) { return `${algo} ${url}`; }

// A number as sent: a JSON number, or a plain decimal string. Not hex, binary or other forms
// Number() would accept ("0x1F"), which no feed means to send.
const DECIMAL = /^\s*-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && DECIMAL.test(v)) return Number(v);
  return NaN;
}

/** Validate a parsed feed body. Returns {ok, blended, rate, asOf} or {ok:false, error}. */
function parseBody(body, nowSec) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'not a JSON object' };
  const blended = num(body.blended_ceiling_sats_unit_day);
  if (!Number.isFinite(blended) || blended < 0) return { ok: false, error: 'blended_ceiling_sats_unit_day missing or invalid' };
  let rate = null;
  if (body.rate_ceiling_sats_th_hour != null) {
    rate = num(body.rate_ceiling_sats_th_hour);
    if (!Number.isFinite(rate) || rate < 0) return { ok: false, error: 'rate_ceiling_sats_th_hour invalid' };
  }
  const asOf = num(body.as_of);
  if (!Number.isFinite(asOf) || asOf <= 0) return { ok: false, error: 'as_of missing or invalid' };
  if (asOf > nowSec + FUTURE_SKEW_S) {
    return { ok: false, error: asOf > 1e12 ? 'as_of looks like milliseconds; send unix seconds' : 'as_of is in the future' };
  }
  // Within the allowed skew, a reading from slightly ahead counts as taken now, so it can't
  // outlive the max age by the skew.
  return { ok: true, blended, rate, asOf: Math.min(asOf, nowSec) };
}

/**
 * Read the body as UTF-8, stopping at MAX_BODY_BYTES. res.text() would buffer whatever arrives
 * before any check could run: a chunked reply with no content-length, or a small gzip body that
 * inflates (fetch decompresses), could take the process's memory, which the engine and the
 * dashboard share. Counting the bytes as they arrive bounds it.
 */
async function readBounded(res) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) throw new Error('response too large');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();   // test stand-ins without a stream
    if (Buffer.byteLength(t) > MAX_BODY_BYTES) throw new Error('response too large');
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// A fetch failure as something a user can act on. Node's fetch reports DNS, refused connections,
// TLS and redirects all as "fetch failed", with the reason in e.cause.
function describeError(e) {
  if (!e) return 'unknown error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
  const c = e.cause;
  if (c && /redirect/i.test(String(c.message || ''))) return 'redirects are not followed; use the final URL';
  if (c && (c.code || c.message)) return `${e.message}: ${c.code || ''}${c.code && c.message ? ' ' : ''}${c.message || ''}`.trim();
  return String(e.message || e);
}

/**
 * Read the feed for the active algorithm, if one is set, and remember the result. Never throws.
 *
 * Any failed read clears the reading, as the issue specifies: a reply that is missing, unreadable,
 * an error status, or fails validation counts as a ceiling of 0 from that moment, not after the
 * max age. A feed that knows its data is bad can say so (HTTP 503, or no ceiling in the body) and
 * spending stops at once. The cost of a one-off network blip is one tick without new spend.
 */
async function refresh(conn, { nowSec = Math.floor(Date.now() / 1000), fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = config.getKey(conn, 'guardrails', 'ceiling_source_url');
  if (!url) return null;
  const algo = market.activeAlgo(conn);
  const k = keyOf(algo, url);
  // Forget readings for other URLs on this algorithm: a URL switched back to starts unread.
  for (const key of state.keys()) if (key.startsWith(`${algo} `) && key !== k) state.delete(key);
  const st = state.get(k) || { good: null, error: null, attemptedAt: null };
  st.attemptedAt = nowSec;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readBounded(res);
    let body;
    // A leading byte-order mark is valid UTF-8 that JSON.parse refuses; some tools write one.
    try { body = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('not JSON'); }
    const p = parseBody(body, nowSec);
    if (!p.ok) throw new Error(p.error);
    // Optional, and checked when present: the ceilings are read in this algorithm's own unit, so the
    // same feed pasted into both algorithms' settings would be a thousandfold off on one of them.
    const unit = algos.priceUnit(algo);
    if (body.algo != null && String(body.algo).toLowerCase() !== algo) throw new Error(`feed is for ${String(body.algo).slice(0, 20)}, not ${algo}`);
    if (body.price_unit != null && String(body.price_unit).toLowerCase() !== String(unit).toLowerCase()) {
      throw new Error(`feed is priced per ${String(body.price_unit).slice(0, 10)}, not per ${unit}`);
    }
    st.good = { blended: p.blended, rate: p.rate, asOf: p.asOf, fetchedAt: nowSec };
    st.error = null;
  } catch (e) {
    st.good = null;   // fail closed now, not at the max age
    st.error = describeError(e).slice(0, 200);
  }
  state.set(k, st);
  return st;
}

/**
 * The ceilings in force now for the active algorithm.
 *   { blendedSatsUnitDay, rateSatsThHour, halted, source }
 * blendedSatsUnitDay / rateSatsThHour: null = no ceiling. halted: spend must not open (the feed has
 * no fresh reading, or a ceiling in force is 0). source: null when no feed is set, else, for display,
 *   { url, ok, asOf, ageS, maxAgeS, error, blended, rate, zero, cappedBlended, cappedRate, noUpperLimit }
 *
 * Upper limits on a feed: the stored ceilings, both of them, whenever set. That is what the
 * setting's help promises ("never above the ceilings set here"), and the number Settings shows is
 * the one that holds. When one caps the feed, the status line says so and gives the feed's own
 * value, so an old ceiling can't hold the feed down unseen; clearing it lets the feed through.
 */
function effective(conn, nowSec = Math.floor(Date.now() / 1000)) {
  const guard = config.get(conn, 'guardrails');
  const storedBlended = guard.blended_ceiling_sats_unit_day;
  const storedRate = guard.rate_ceiling_sats_th_hour;
  const url = guard.ceiling_source_url;
  if (!url) {
    return { blendedSatsUnitDay: storedBlended, rateSatsThHour: storedRate, halted: storedBlended === 0 || storedRate === 0, source: null };
  }
  const limitBlended = storedBlended;
  const maxAgeS = guard.ceiling_source_max_age_s || 900;
  const st = state.get(keyOf(market.activeAlgo(conn), url)) || { good: null, error: null };
  const good = st.good;
  const ageS = good ? Math.max(0, nowSec - good.asOf) : null;
  const fresh = !!good && ageS <= maxAgeS;
  const source = {
    url: displayUrl(url), ok: fresh, asOf: good ? good.asOf : null, ageS, maxAgeS,
    error: st.error || (good ? (fresh ? null : 'stale') : 'not read yet'),
    blended: good ? good.blended : null, rate: good ? good.rate : null,
    zero: false, cappedBlended: false, cappedRate: false,
    noUpperLimit: limitBlended == null,
  };
  if (!fresh) return { blendedSatsUnitDay: 0, rateSatsThHour: 0, halted: true, source };
  // The stored ceilings stay the upper limits: the feed can tighten them, never loosen them.
  const capBy = (feed, local) => (local == null ? feed : Math.min(feed, local));
  const blended = capBy(good.blended, limitBlended);
  const rate = good.rate == null ? storedRate : capBy(good.rate, storedRate);
  source.cappedBlended = limitBlended != null && good.blended > limitBlended;
  source.cappedRate = good.rate != null && storedRate != null && good.rate > storedRate;
  source.zero = blended === 0 || rate === 0;
  return { blendedSatsUnitDay: blended, rateSatsThHour: rate, halted: source.zero, source };
}

// The URL as shown in the status and alerts: without a query string or fragment, where a token
// would usually sit, since both are shown on screen and kept in the alerts table.
function displayUrl(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search || u.hash ? '?…' : ''}`; } catch { return '(invalid URL)'; }
}

/** Test-only. */
function _reset() { state.clear(); }

module.exports = { refresh, effective, parseBody, _reset, FETCH_TIMEOUT_MS };
