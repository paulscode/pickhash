'use strict';
/*
 * Exchange rates for the header converter: sats on the SHA256 chain, sats on the
 * BLAKE2b chain, and fiat.
 *
 * The method follows the BLAKE2b Sparrow wallet's, which worked through the same
 * traps first:
 *
 *   - BTCB2 in dollars comes from Neoxa's BTCB2_USDC market, its deepest by a wide
 *     margin, with USDC taken as a dollar. NOT from BTCB2_BTC times an outside BTC
 *     price: Neoxa's own BTC market is thin enough to drift several percent from the
 *     wider one, and that construction counts the gap twice.
 *   - Every other currency is reached through CoinGecko's exchange-rate table, which
 *     quotes one BTC in each fiat. Only the RATIO of two of its quotes touches the
 *     BTCB2 price (BTC in EUR / BTC in USD = EUR per USD), so CoinGecko's opinion of
 *     bitcoin cancels out of it.
 *   - A price of zero means "never traded", not "worthless", and is treated as absent.
 *
 * The SHA256 side needs BTC's own fiat price, which that same table carries. When
 * CoinGecko is down, mempool.space's price feed stands in for the major currencies.
 *
 * The two sats amounts are converted to each other THROUGH fiat, never via a direct
 * BTCB2/BTC pair, so the three fields always agree with each other exactly.
 *
 * One fetch per source per minute at most, shared by every open page; a failed source
 * keeps serving its last good value for a while, marked stale, so a blip doesn't blank
 * a converter someone is using.
 */

const NEOXA_URL = 'https://neoxa.exchange/api/v1/cmc/ticker';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/exchange_rates';
const MEMPOOL_URL = 'https://mempool.space/api/v1/prices';

const BTCB2_USD_PAIR = 'BTCB2_USDC';
const REFRESH_MS = 60 * 1000;
const STALE_MS = 15 * 60 * 1000;   // past this, an old rate is worse than none
const TIMEOUT_MS = 8000;

// Shown first in the picker, in this order; everything else follows alphabetically.
const COMMON = ['usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'chf', 'cny', 'inr', 'brl'];

// mempool.space quotes only these, and names none of them.
const MEMPOOL_NAMES = {
  usd: 'US Dollar', eur: 'Euro', gbp: 'British Pound Sterling', cad: 'Canadian Dollar',
  chf: 'Swiss Franc', aud: 'Australian Dollar', jpy: 'Japanese Yen',
};

/** A traded price, or null. Zero, negative, and non-numbers are all "no price". */
function validPrice(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** BTCB2 in dollars from Neoxa's ticker feed, or null. */
function parseNeoxa(json) {
  const t = json && typeof json === 'object' ? json[BTCB2_USD_PAIR] : null;
  return t ? validPrice(t.last_price) : null;
}

/** { btc: {code: BTC price in that fiat}, names: {code: name} } from CoinGecko, or null. */
function parseCoinGecko(json) {
  const rates = json && json.rates;
  if (!rates || typeof rates !== 'object') return null;
  const btc = {};
  const names = {};
  for (const [code, r] of Object.entries(rates)) {
    if (!r || r.type !== 'fiat' || !/^[a-z]{3}$/.test(code)) continue;
    const v = validPrice(r.value);
    if (v == null) continue;
    btc[code] = v;
    names[code] = typeof r.name === 'string' ? r.name : code.toUpperCase();
  }
  return btc.usd ? { btc, names } : null;   // USD anchors every cross rate; without it the table is useless
}

/** The same shape from mempool.space's feed (major currencies only), or null. */
function parseMempool(json) {
  if (!json || typeof json !== 'object') return null;
  const btc = {};
  const names = {};
  for (const [code, name] of Object.entries(MEMPOOL_NAMES)) {
    const v = validPrice(json[code.toUpperCase()]);
    if (v != null) { btc[code] = v; names[code] = name; }
  }
  return btc.usd ? { btc, names } : null;
}

/**
 * The per-currency table the converter works from: one BTC and one BTCB2 in each fiat.
 *
 * A currency is listed when at least one side prices in it. Dollars are always listed
 * when BTCB2 has a price, since that needs nothing but Neoxa: a CoinGecko outage must
 * not take away the one currency that still works.
 */
function buildTable(btcb2Usd, btcSide) {
  const btc = (btcSide && btcSide.btc) || {};
  const names = (btcSide && btcSide.names) || {};
  const codes = new Set(Object.keys(btc));
  if (btcb2Usd != null) codes.add('usd');
  const rank = (c) => { const i = COMMON.indexOf(c); return i < 0 ? COMMON.length : i; };
  return [...codes]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((code) => {
      let b2 = null;
      if (btcb2Usd != null) {
        if (code === 'usd') b2 = btcb2Usd;
        else if (btc.usd && btc[code]) b2 = btcb2Usd * (btc[code] / btc.usd);
      }
      return {
        code,
        name: names[code] || (code === 'usd' ? 'US Dollar' : code.toUpperCase()),
        btc: btc[code] != null ? btc[code] : null,
        btcb2: b2,
      };
    });
}

async function fetchJson(url, fetchImpl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) { const e = new Error(`http_${res.status}`); e.reason = res.status === 429 ? 'rate_limited' : 'bad_response'; throw e; }
    try { return await res.json(); } catch { const e = new Error('bad_json'); e.reason = 'bad_response'; throw e; }
  } catch (e) {
    if (!e.reason) e.reason = 'unreachable';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Per-side cache: the last good value, when it was fetched, and why the latest attempt
 * failed (if it did). `source` names where the value came from, since the BTC side can
 * fall back from CoinGecko to mempool.space.
 */
function freshState() {
  return {
    btcb2: { value: null, at: 0, error: null, source: 'Neoxa' },
    btc: { value: null, at: 0, error: null, source: 'CoinGecko' },
    attemptAt: 0,
    inflight: null,
  };
}
let state = freshState();

async function refresh(fetchImpl, nowMs) {
  state.attemptAt = nowMs;
  const b2 = fetchJson(NEOXA_URL, fetchImpl).then((j) => {
    const v = parseNeoxa(j);
    if (v == null) { const e = new Error('no_price'); e.reason = 'no_price'; throw e; }
    return v;
  });
  const btc = fetchJson(COINGECKO_URL, fetchImpl).then((j) => {
    const v = parseCoinGecko(j);
    if (!v) { const e = new Error('no_price'); e.reason = 'bad_response'; throw e; }
    return { value: v, source: 'CoinGecko' };
  }).catch((primaryErr) => fetchJson(MEMPOOL_URL, fetchImpl).then((j) => {
    const v = parseMempool(j);
    if (!v) throw primaryErr;
    return { value: v, source: 'mempool.space' };
  }).catch(() => { throw primaryErr; }));   // report the primary's reason; the fallback is a bonus

  const [r1, r2] = await Promise.allSettled([b2, btc]);
  if (r1.status === 'fulfilled') state.btcb2 = { value: r1.value, at: nowMs, error: null, source: 'Neoxa' };
  else state.btcb2 = { ...state.btcb2, error: r1.reason.reason || 'unreachable' };
  if (r2.status === 'fulfilled') state.btc = { value: r2.value.value, at: nowMs, error: null, source: r2.value.source };
  else state.btc = { ...state.btc, error: r2.reason.reason || 'unreachable' };
}

/** One side's status for the UI: usable value (or null) plus why, and whether it is stale. */
function sideStatus(side, nowMs) {
  const age = side.at ? nowMs - side.at : Infinity;
  const usable = side.value != null && age <= STALE_MS;
  return {
    usable,
    value: usable ? side.value : null,
    status: {
      ok: usable && !side.error,
      stale: usable && !!side.error,
      error: usable ? side.error : (side.error || 'unreachable'),
      source: side.source,
      at: side.at ? Math.floor(side.at / 1000) : null,
    },
  };
}

/**
 * Current rates, refreshing first if the last attempt is over a minute old. Concurrent
 * callers share one refresh. Never throws: a failure shows up in the source status.
 */
async function getRates({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (now - state.attemptAt >= REFRESH_MS) {
    if (!state.inflight) {
      state.inflight = refresh(fetchImpl, now).finally(() => { state.inflight = null; });
    }
    await state.inflight;
  } else if (state.inflight) {
    await state.inflight;
  }
  const b2 = sideStatus(state.btcb2, now);
  const btc = sideStatus(state.btc, now);
  return {
    currencies: buildTable(b2.value, btc.value),
    sources: {
      btcb2: { ...b2.status, pair: 'BTCB2/USDC' },
      btc: btc.status,
    },
    refresh_seconds: REFRESH_MS / 1000,
  };
}

/** A fiat code as stored: three lowercase letters, or null. */
function normalizeCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return /^[a-z]{3}$/.test(c) ? c : null;
}

function _reset() { state = freshState(); }

module.exports = {
  getRates, normalizeCode,
  // pure helpers, exported for tests
  validPrice, parseNeoxa, parseCoinGecko, parseMempool, buildTable,
  REFRESH_MS, STALE_MS, _reset,
};
