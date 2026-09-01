'use strict';
/*
 * Marketplace access: fetch the active algorithm's rigs, normalize them to internal units, and
 * record periodic snapshots.
 *
 * Units are the load-bearing part. The API quotes sha256ab in PH: advertised
 * hashrate and price are per-PH, and the short-window measured hashrate is in MH.
 * We normalize hashrate to TH/s and price to BTC per TH per day. (Confirmed against
 * the live API: advertised.type "ph", last_Xmin.type "mh", price.type "ph".)
 */
const units = require('./units');
const config = require('./config');
const algos = require('./algos');

/**
 * The algorithm this instance is operating on, for scoping reads and stamping writes.
 *
 * The single source of truth, and now genuinely the only way to learn the slug:
 * api.js and bootstrap.js used to spell it out themselves, so flipping one constant
 * would have left the app reading one algorithm's marketplace while creating and
 * testing another's pool and profile. The MRR account objects are per-algorithm and
 * a mismatch between them surfaces far from its cause.
 *
 * The setting itself lives in config.js because the config layer needs it to resolve
 * an algorithm-scoped namespace, and market.js already reads config; owning it here
 * would be a require cycle. This re-export exists because most call sites are asking
 * a market question, not a settings question.
 */
function activeAlgo(conn) {
  return config.activeAlgo(conn);
}

function num(v) { return v === '' || v === null || v === undefined ? null : Number(v); }

// The API returns booleans sometimes as JSON booleans, sometimes as "0"/"1"/"true"
// strings. Coerce defensively so a stringy "0" can't read as truthy (`!!"0" === true`).
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'null');
}

// Convert to TH/s, tolerating a missing/unknown unit so one malformed rig can't throw
// and abort an entire market page.
function toThSafe(value, type) {
  if (value == null || value === '') return null;
  try { return units.toTh(value, type); } catch { return null; }
}

// A finite number or null — never NaN (a NaN would slip past `!= null` gates and poison
// aggregates like `lowest`).
function finiteNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Price in BTC per TH per day, tolerating a malformed price OR an unknown price unit the
// same way toThSafe does: one bad rig on the marketplace (third-party data) must not throw
// and freeze the whole market snapshot, nor let a NaN price poison `lowest`/`depth`.
function priceBtcThDaySafe(price, type) {
  const p = finiteNum(price);
  if (p == null) return null;
  let factor;
  try { factor = units.perThFactor(type); } catch { return null; }
  return p / factor;
}

/** Normalize one raw rig record to the internal shape (all hashrate TH/s). */
function normalizeRig(raw) {
  const btc = (raw.price && raw.price.BTC) || {};
  const adv = (raw.hashrate && raw.hashrate.advertised) || {};
  const h = raw.hashrate || {};
  const priceType = (raw.price && raw.price.type) || 'ph';
  const measured = (w) => toThSafe(w && w.hash, w && w.type);
  return {
    id: String(raw.id),
    name: raw.name,
    owner: raw.owner,
    region: raw.region,
    rpi: num(raw.rpi),
    advertisedTh: toThSafe(adv.hash, adv.type),
    measuredTh: { m5: measured(h.last_5min), m15: measured(h.last_15min), m30: measured(h.last_30min) },
    // price.BTC.price is BTC per <priceType> per day; divide by TH-per-unit to get per-TH.
    priceBtcThDay: priceBtcThDaySafe(btc.price, priceType),
    hourBtc: finiteNum(btc.hour),   // BTC/hr for the FULL advertised hashrate
    minHours: num(raw.minhours),
    maxHours: num(raw.maxhours),
    minRentalLength: btc.min_rental_length != null ? Number(btc.min_rental_length) : null,
    optimalDiff: raw.optimal_diff ? { min: num(raw.optimal_diff.min), max: num(raw.optimal_diff.max) } : null,
    extensions: bool(raw.extensions),
    online: bool(raw.online),
    poolstatus: raw.poolstatus,
    status: raw.status && raw.status.status,   // available|rented|offline|disabled
    rented: bool(raw.status && raw.status.rented),
    available: raw.available_status === 'available',
    priceEnabled: bool(btc.enabled),           // is BTC pricing enabled for this rig
  };
}

/** Map a raw `GET /rig` search page to normalized rigs + its stats envelope. */
function normalizeSearchPage(resp) {
  const records = (resp && resp.records) || [];
  return {
    total: num(resp && resp.total),
    offset: num(resp && resp.offset),
    count: num(resp && resp.count),
    stats: resp && resp.stats,
    rigs: records.map(normalizeRig),
  };
}

/**
 * Aggregate a market snapshot from normalized rigs. "Rentable" = BTC pricing
 * enabled, available, not rented, online, pool online — the same gate the quote
 * engine will use, so the depth reflects what a user could actually buy.
 */
function buildMarketSnapshot(rigs, tsSeconds) {
  const rentable = rigs.filter((r) =>
    r.priceEnabled && r.available && !r.rented && r.online && r.poolstatus === 'online'
    && r.advertisedTh > 0 && Number.isFinite(r.priceBtcThDay));
  const availableTh = rentable.reduce((s, r) => s + r.advertisedTh, 0);
  const lowest = rentable.reduce((lo, r) => (lo == null || r.priceBtcThDay < lo ? r.priceBtcThDay : lo), null);
  const depth = rentable
    .map((r) => ({ priceBtcThDay: r.priceBtcThDay, th: r.advertisedTh, region: r.region || null }))
    .sort((a, b) => a.priceBtcThDay - b.priceBtcThDay);
  return {
    ts: tsSeconds,
    lowest,
    last10: null,   // filled from GET /info/algos stats when available
    last: null,
    availableRigs: rentable.length,
    availableTh,
    depth,
  };
}

/** Persist a snapshot row. */
function writeSnapshot(conn, snap) {
  conn.prepare(`INSERT OR REPLACE INTO market_snapshots
    (algo, ts, lowest, last10, last, available_rigs, available_th, depth_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    activeAlgo(conn), snap.ts, snap.lowest, snap.last10, snap.last, snap.availableRigs, snap.availableTh,
    JSON.stringify(snap.depth || []));
}

/**
 * Fetch every rig for one algorithm, paginating 100 at a time.
 *
 * `algo` is required and deliberately has no default. This is the call that decides
 * which marketplace the whole app is looking at, and a default here would mean a
 * caller that forgot silently priced, rented and charged against the wrong one.
 */
async function fetchAllRigs(client, algo, filters = {}) {
  if (!algos.isKnown(algo)) throw new Error(`fetchAllRigs: unknown algorithm ${algo}`);
  const out = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const page = await client.get('/rig', { type: algo, count: 100, offset, ...filters });
    const norm = normalizeSearchPage(page);
    out.push(...norm.rigs);
    // Use the reported total only if it's a real number; otherwise keep paginating
    // until an empty page (a garbage `total` must not cause an early under-fetch).
    total = Number.isFinite(norm.total) ? norm.total : Infinity;
    // Advance by rigs actually returned, not the API's `count` field, so a short or
    // mislabeled final page can't skip or double-count rigs.
    if (!norm.rigs.length) break;
    offset += norm.rigs.length;
  }
  return out;
}

/** Available TH + rig count per region from a snapshot's depth array. Pure. Sorted TH-desc. */
function depthByRegion(depth) {
  const by = {};
  for (const d of depth || []) {
    const r = (d && d.region) || 'unknown';
    by[r] = by[r] || { region: r, th: 0, rigs: 0 };
    by[r].th += (d && d.th) || 0;
    by[r].rigs += 1;
  }
  return Object.values(by).sort((a, b) => b.th - a.th);
}

/**
 * Where the CURRENT lowest price sits vs recent snapshots' lowest — a "cheap right now?" read.
 * Pure. `percentile` = share of recent snapshots cheaper than now (low = cheap). Returns
 * { available:false } when there's no current price or no history to compare against.
 */
function cheapNow(current, history) {
  const vals = (history || []).map((r) => r.lowest).filter((v) => v != null).sort((a, b) => a - b);
  if (current == null || !vals.length) return { available: false };
  const below = vals.filter((v) => v < current).length;
  const percentile = Math.round((below / vals.length) * 100);
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;   // true median (avg the two middle for even N)
  return {
    available: true,
    percentile,
    label: percentile <= 25 ? 'cheap' : percentile >= 75 ? 'pricey' : 'typical',
    min: vals[0], max: vals[vals.length - 1], median, current,
    vs_median_pct: median > 0 ? Math.round(((current - median) / median) * 100) : 0,
    samples: vals.length,
  };
}

/**
 * "Hash Value" comparison (sats/PH·day): your blended pay-rate vs the market rate. Pure.
 * @param {object|null} latest   newest market_snapshots row ({ lowest, last10 }) or null
 * @param {Array} rentals        active rentals: [{ rate_btc_th_day, advertised_th, avg_percent }]
 * market = last10 (recent-rentals avg) when present, else lowest. your_pay is TH-weighted over
 * ADVERTISED TH (apples-to-apples vs the market rate); effective is over DELIVERED TH (true cost;
 * an unmeasured/ramping rig counts as fully delivering so it isn't spuriously penalized).
 */
function hashValue(latest, rentals, priceUnit) {
  // BTC/TH·day -> sats per <unit>·day. Was a literal 1e11, which is 1e8 sats per BTC
  // times the 1000 TH in a PH: correct only for an algorithm quoted per PH.
  const SATS = units.perThFactor(priceUnit) * units.SATS_PER_BTC;
  const lowest = latest && latest.lowest != null ? latest.lowest * SATS : null;
  const market = latest && latest.last10 != null ? latest.last10 * SATS : lowest;
  const live = (rentals || []).filter((r) => r && Number.isFinite(r.rate_btc_th_day) && r.advertised_th > 0);
  let pay = null;
  let effective = null;
  if (live.length) {
    const costRate = live.reduce((s, r) => s + r.rate_btc_th_day * r.advertised_th, 0);   // BTC/day across held rigs
    const adv = live.reduce((s, r) => s + r.advertised_th, 0);
    const delivered = live.reduce((s, r) => s + r.advertised_th * (r.avg_percent != null ? r.avg_percent / 100 : 1), 0);
    pay = adv > 0 ? (costRate / adv) * SATS : null;
    effective = delivered > 0 ? (costRate / delivered) * SATS : null;
  }
  const overMarketPct = (pay != null && market != null && market > 0) ? Math.round(((pay - market) / market) * 1000) / 10 : null;
  return {
    available: market != null && pay != null,
    price_unit: priceUnit,
    market_sats_unit_day: market != null ? Math.round(market) : null,
    lowest_sats_unit_day: lowest != null ? Math.round(lowest) : null,
    your_pay_sats_unit_day: pay != null ? Math.round(pay) : null,
    effective_sats_unit_day: effective != null ? Math.round(effective) : null,
    over_market_pct: overMarketPct,
  };
}

module.exports = { activeAlgo, normalizeRig, normalizeSearchPage, buildMarketSnapshot, writeSnapshot, fetchAllRigs, depthByRegion, cheapNow, hashValue };
