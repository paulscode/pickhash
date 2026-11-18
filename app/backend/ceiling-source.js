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
 *     "as_of": 1791103808 }                       // required, unix seconds
 *
 * It is a money control, so it fails CLOSED. A feed that is unreachable, unreadable, missing a
 * required field, or older than guardrails.ceiling_source_max_age_s counts as a ceiling of 0, and
 * autopilot and auto-extend rent and extend nothing until it is good again. Nothing is cancelled:
 * running rentals run out as they would.
 *
 * The stored ceilings, when set, stay the upper limits: the feed can tighten them, never loosen
 * them. A compromised or buggy feed can then stop spending but cannot raise it past what the user
 * set by hand.
 *
 * State is in memory, keyed by algorithm and URL, because the engine and the API run in one
 * process. A restart starts with no reading, which fails closed until the first tick reads the feed.
 */
const config = require('./config');
const market = require('./market');

const FETCH_TIMEOUT_MS = 4000;          // a slow feed must not hold up the engine tick
const MAX_BODY_BYTES = 64 * 1024;
const FUTURE_SKEW_S = 300;              // an as_of further ahead than this is a broken clock or a ms value

const state = new Map();   // `${algo} ${url}` -> { good: {blended, rate, asOf, fetchedAt} | null, error, attemptedAt }

function keyOf(algo, url) { return `${algo} ${url}`; }

/** Validate a parsed feed body. Returns {ok, blended, rate, asOf} or {ok:false, error}. */
function parseBody(body, nowSec) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'not a JSON object' };
  const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN));
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
  return { ok: true, blended, rate, asOf };
}

/**
 * Read the feed for the active algorithm, if one is set, and remember the result. Never throws.
 * A failure keeps the last good reading, which then ages out on its own.
 */
async function refresh(conn, { nowSec = Math.floor(Date.now() / 1000), fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = config.getKey(conn, 'guardrails', 'ceiling_source_url');
  if (!url) return null;
  const k = keyOf(market.activeAlgo(conn), url);
  const st = state.get(k) || { good: null, error: null, attemptedAt: null };
  st.attemptedAt = nowSec;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) throw new Error('response too large');
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('not JSON'); }
    const p = parseBody(body, nowSec);
    if (!p.ok) throw new Error(p.error);
    st.good = { blended: p.blended, rate: p.rate, asOf: p.asOf, fetchedAt: nowSec };
    st.error = null;
  } catch (e) {
    st.error = String((e && e.name === 'TimeoutError') ? 'timed out' : (e && e.message) || e).slice(0, 200);
  }
  state.set(k, st);
  return st;
}

/**
 * The ceilings in force now for the active algorithm.
 *   { blendedSatsUnitDay, rateSatsThHour, halted, source }
 * blendedSatsUnitDay / rateSatsThHour: null = no ceiling. halted: spend must not open (the feed is
 * stale or failing, or a ceiling in force is 0). source: null when no feed is set, else
 *   { url, ok, asOf, ageS, maxAgeS, error, blended, rate } for display.
 */
function effective(conn, nowSec = Math.floor(Date.now() / 1000)) {
  const guard = config.get(conn, 'guardrails');
  const storedBlended = guard.blended_ceiling_sats_unit_day;
  const storedRate = guard.rate_ceiling_sats_th_hour;
  const url = guard.ceiling_source_url;
  if (!url) {
    return { blendedSatsUnitDay: storedBlended, rateSatsThHour: storedRate, halted: storedBlended === 0 || storedRate === 0, source: null };
  }
  const maxAgeS = guard.ceiling_source_max_age_s || 900;
  const st = state.get(keyOf(market.activeAlgo(conn), url)) || { good: null, error: null };
  const good = st.good;
  const ageS = good ? Math.max(0, nowSec - good.asOf) : null;
  const fresh = !!good && ageS <= maxAgeS;
  const source = {
    url, ok: fresh, asOf: good ? good.asOf : null, ageS, maxAgeS,
    error: st.error || (good ? (fresh ? null : 'stale') : 'not read yet'),
    blended: good ? good.blended : null, rate: good ? good.rate : null,
  };
  if (!fresh) return { blendedSatsUnitDay: 0, rateSatsThHour: 0, halted: true, source };
  // The stored ceilings stay the upper limits: the feed can tighten them, never loosen them.
  const capBy = (feed, local) => (local == null ? feed : Math.min(feed, local));
  const blended = capBy(good.blended, storedBlended);
  const rate = good.rate == null ? storedRate : capBy(good.rate, storedRate);
  return { blendedSatsUnitDay: blended, rateSatsThHour: rate, halted: blended === 0 || rate === 0, source };
}

/** Test-only. */
function _reset() { state.clear(); }

module.exports = { refresh, effective, parseBody, _reset, FETCH_TIMEOUT_MS };
