'use strict';
/*
 * Quote service — the impure shell around the pure quote engine (quote.js).
 *
 * It fetches fresh market data (cached ~30s, since rigs get taken), the account
 * balance, and algo market stats; assembles engine options from config + the active
 * pool endpoint + local rig scores; runs the packer; and returns a fee-inclusive
 * quote with a short-lived id the session step re-validates at confirm time.
 *
 * The pure helpers (param mapping, market-context math, algo parsing) are exported so
 * they can be unit-tested without any network.
 */
const crypto = require('node:crypto');
const config = require('./config');
const market = require('./market');
const quote = require('./quote');
const deposit = require('./deposit');
const scoring = require('./engine/scoring');
const algos = require('./algos');
const units = require('./units');
const endpoints = require('./endpoints');

const MARKET_TTL_MS = 30_000;   // rigs get rented; a quote shouldn't be built on stale depth
const QUOTE_TTL_MS = 60_000;    // a quote id is honored this long, then re-priced at confirm

// { algo, rigs, at }. Keyed by algorithm, not just time: a cache hit from the other
// algorithm's marketplace would price a quote against rigs that cannot be rented for
// this one, and the 30s window is easily long enough to span a switch.
let marketCache = null;
const quotes = new Map();       // id -> stored quote

function nowMs() { return Date.now(); }
function invalidateMarket() { marketCache = null; }
/*
 * Drop every held quote.
 *
 * A quote is a priced plan against one marketplace: specific rig ids, a blended rate,
 * a rate cap in that algorithm's unit. After an algorithm switch none of that means
 * anything, and the rigs it names cannot be rented at all.
 */
function invalidateQuotes() { quotes.clear(); }

async function freshMarket(client, algo, force = false) {
  if (!force && marketCache && marketCache.algo === algo && nowMs() - marketCache.at < MARKET_TTL_MS) {
    return marketCache;
  }
  const rigs = await market.fetchAllRigs(client, algo);
  marketCache = { algo, rigs, at: nowMs() };
  return marketCache;
}

/** Engine options from config + the active endpoint + local rig scores. */
function engineOpts(conn) {
  const strat = config.get(conn, 'strategy');
  const ep = endpoints.active(conn);
  const rigScores = scoring.loadRigScores(conn);   // learned per-rig delivery -> 0..1 expected-delivery factor
  return {
    mode: 'quick',
    minRpi: strat.min_rpi,
    stabilityTolerancePct: strat.stability_tolerance_pct,
    allowUnproven: strat.allow_unproven_rigs === true,
    blacklist: strat.blacklist_rig_ids || [],
    endpointDiff: ep && ep.stratum_diff != null ? Number(ep.stratum_diff) : null,
    // Detected by the endpoint test, not assumed: a stock gateway discards the password.
    supportsPasswordDiff: !!(ep && ep.supports_password_diff),
    rigScores,
    regionInclude: strat.region_include || [],
    regionExclude: strat.region_exclude || [],
    endpoint: ep,
  };
}

/** Region include/exclude are a service-level filter (not part of hard eligibility). */
function applyRegion(rigs, opts) {
  let rs = rigs;
  if (opts.regionInclude && opts.regionInclude.length) rs = rs.filter((r) => opts.regionInclude.includes(r.region));
  if (opts.regionExclude && opts.regionExclude.length) rs = rs.filter((r) => !opts.regionExclude.includes(r.region));
  return rs;
}

/**
 * Map UI input to packer params. `compute` is the field the user is solving for:
 *   'duration' <- spend + hashrate ;  'hashrate' <- spend + duration ;  'spend' <- hashrate + duration.
 * Throws 'missing_inputs' if the two required fields aren't present and positive.
 */
function toPackerParams(input) {
  const budgetSats = input.spendSats != null ? Math.floor(Number(input.spendSats)) : null;
  const targetTh = input.hashrateTh != null ? Number(input.hashrateTh) : null;
  const durationHours = input.durationHours != null ? Number(input.durationHours) : null;
  const ok = (...xs) => xs.every((x) => x != null && Number.isFinite(x) && x > 0);
  if (input.compute === 'duration') { if (!ok(budgetSats, targetTh)) throw new Error('missing_inputs'); return { compute: 'duration', budgetSats, targetTh }; }
  if (input.compute === 'hashrate') { if (!ok(budgetSats, durationHours)) throw new Error('missing_inputs'); return { compute: 'target', budgetSats, durationHours }; }
  if (input.compute === 'spend') { if (!ok(targetTh, durationHours)) throw new Error('missing_inputs'); return { compute: 'budget', targetTh, durationHours }; }
  throw new Error('bad_compute');
}

/** Clamp a requested spend to the guardrail ceiling; flag when it bites. */
function clampBudget(conn, params) {
  const cap = config.getKey(conn, 'guardrails', 'max_session_budget_sats');
  if (params.budgetSats != null && cap != null && params.budgetSats > cap) {
    return { params: { ...params, budgetSats: cap }, guardWarnings: ['budget_capped'] };
  }
  return { params, guardWarnings: [] };
}

/**
 * Pull the suggested/last prices out of a GET /info/algos/<algo> response,
 * normalized to BTC per TH per day like every other price in the app.
 *
 * The unit comes from the response ("ph*day" for sha256ab, "th*day" for blake2b)
 * rather than being assumed. Taking the amounts at face value and treating them as
 * per-PH, which is what this did, puts every blake2b market comparison out by a
 * factor of a thousand — and it is the comparison the UI uses to tell the user
 * whether they are getting a good price.
 */
function parseAlgo(a) {
  if (!a) return null;
  const r = a.result || a;   // tolerate a {result:...} envelope
  const sp = r.suggested_price || {};
  const prices = (r.stats && r.stats.prices) || r.prices || {};
  const perTh = (o) => {
    if (!o || o.amount == null || o.amount === '') return null;
    const n = Number(o.amount);
    if (!Number.isFinite(n)) return null;
    // "ph*day" -> "ph". A missing or unrecognised unit yields null rather than a
    // guess: the market badge is a nice-to-have, and a wrong guess here is a silent
    // thousandfold error on the number the user is judging a price by.
    try { return n / units.perThFactor(String(o.unit || '').split('*')[0]); } catch { return null; }
  };
  return {
    suggestedBtcThDay: perTh(sp),
    last10BtcThDay: perTh(prices.last_10),
    lastBtcThDay: perTh(prices.last),
  };
}

/**
 * Human market-context badge: blended quote price vs the last-10-rental average. Pure.
 *
 * Everything here is BTC per TH per day, so the comparison holds whichever unit the
 * algorithm is quoted in. Only the two numbers handed to the UI are converted back
 * to the quoted unit, and they carry that unit with them.
 */
function marketContext(blendedBtcThDay, algo, priceUnit) {
  if (!algo) return null;
  const ref = algo.last10BtcThDay != null ? algo.last10BtcThDay : algo.suggestedBtcThDay;
  const sats = (v) => (v != null ? Math.round(units.satsPerUnitDay(v, priceUnit)) : null);
  const base = {
    price_unit: priceUnit,
    suggested_sats_unit_day: sats(algo.suggestedBtcThDay),
    last10_sats_unit_day: sats(algo.last10BtcThDay),
    delta_pct: null, label: null, tight: false,
  };
  if (ref == null || !(ref > 0) || blendedBtcThDay == null) return base;
  const deltaPct = ((blendedBtcThDay - ref) / ref) * 100;
  let label;
  if (deltaPct <= -1) label = `${Math.abs(Math.round(deltaPct))}% below the last-10 rental average`;
  else if (deltaPct >= 1) label = `${Math.round(deltaPct)}% above the last-10 average — market is tight right now`;
  else label = 'right at the last-10 rental average';
  return { ...base, delta_pct: deltaPct, label, tight: deltaPct >= 5 };
}

function sweepQuotes() {
  const t = nowMs();
  for (const [id, q] of quotes) if (q.expiresAt < t) quotes.delete(id);
}

/** The client-facing shape (snake_case, only what the UI/session need). */
function publicQuote(q) {
  const r = q.result;
  const insufficient = q.balanceSats != null && r.totalSats > q.balanceSats;
  return {
    id: q.id,
    expires_at: Math.floor(q.expiresAt / 1000),
    compute: q.input.compute,
    total_sats: r.totalSats,
    base_sats: r.baseSats,
    fee_sats: r.feeSats,
    duration_hours: r.durationHours,
    target_th: r.targetTh,
    rig_count: r.rigs.length,
    blended_btc_unit_day: q.blendedBtcUnitDay,
    price_unit: q.priceUnit,
    shortfall_th: r.shortfallTh,
    balance_sats: q.balanceSats,
    insufficient_funds: insufficient,
    market_context: q.marketContext,
    endpoint: { host: q.endpoint.host, port: q.endpoint.port, stratum: q.endpoint.stratum },
    warnings: q.warnings,
    rigs: r.rigs.map((x) => ({
      id: x.id, name: x.name, owner: x.owner, region: x.region, rpi: x.rpi,
      advertised_th: x.advertisedTh, length_hours: x.lengthHours,
      paid_sats: x.paidSats, fee_sats: x.feeSats,
    })),
  };
}

/**
 * Build a quote from UI input. Fetches fresh market data, packs, and prices it fully.
 * Returns the public quote object and stashes the full record under its id for confirm.
 */
async function buildQuote(conn, client, input, buildOpts = {}) {
  const opts = engineOpts(conn);
  if (!opts.endpoint) throw new Error('no_endpoint');

  const packParams = toPackerParams(input);          // validates inputs
  // At confirm we force a fresh fetch: reusing the ~30s cache would compare a quote to
  // itself and defeat the reprice guard, executing at a price that may have moved.
  const activeSlug = market.activeAlgo(conn);
  const mkt = await freshMarket(client, activeSlug, buildOpts.forceMarket === true);
  const cands = quote.candidates(applyRegion(mkt.rigs, opts), opts);
  const { params, guardWarnings } = clampBudget(conn, packParams);
  const result = quote.pack(cands, params);

  // Guardrail for spend-locked quotes: there's no input budget to clamp, so enforce the
  // ceiling on the COMPUTED total instead — flag it so the UI blocks renting above it
  // (budget-locked modes are already capped by clampBudget before packing).
  if (params.budgetSats == null) {
    const cap = config.getKey(conn, 'guardrails', 'max_session_budget_sats');
    if (cap != null && result.totalSats > cap) result.warnings = [...result.warnings, 'exceeds_guardrail'];
  }

  // Soft note: some packed rigs are outside their pool's optimal difficulty range. They
  // normally still deliver full hashrate (proven live) — the health chips catch any that don't.
  if (result.rigs.some((r) => r.diffInRange === false)) result.warnings = [...result.warnings, 'diff_edge'];

  // Balance + algo market stats are best-effort — a quote still renders without them.
  let balanceSats = null;
  try { balanceSats = deposit.balanceToSats(await client.get('/account/balance')).confirmed_sats; } catch { /* show no balance */ }
  let algo = null;
  try { algo = parseAlgo(await client.get(`/info/algos/${activeSlug}`)); } catch { /* no market badge */ }

  const priceUnit = algos.priceUnit(activeSlug);
  const blendedBtcUnitDay = result.blendedBtcThDay * units.perThFactor(priceUnit);
  // Only compute a market badge for a real quote — a 0-rig quote has blended 0, which would
  // otherwise read as "100% below market" (a great deal) instead of "nothing available".
  const marketCtx = result.rigs.length && result.blendedBtcThDay > 0
    ? marketContext(result.blendedBtcThDay, algo, priceUnit) : null;
  const ep = opts.endpoint;
  const stored = {
    id: crypto.randomBytes(12).toString('hex'),
    createdAt: nowMs(),
    expiresAt: nowMs() + QUOTE_TTL_MS,
    input,
    params,
    result,
    candidates: cands,   // kept for clean-failure re-pack at execute time
    balanceSats,
    blendedBtcUnitDay,
    priceUnit,
    algo: activeSlug,
    marketContext: marketCtx,
    endpointDiff: opts.endpointDiff,   // for per-rental diff telemetry
    supportsPasswordDiff: !!opts.supportsPasswordDiff,
    endpoint: {
      id: ep.id, host: ep.host, port: ep.port, worker_base: ep.worker_base,
      mrr_profile_id: ep.mrr_profile_id, mrr_pool_id: ep.mrr_pool_id,
      stratum: `stratum+tcp://${ep.host}:${ep.port}`,
    },
    warnings: [...result.warnings, ...guardWarnings],
  };
  quotes.set(stored.id, stored);
  sweepQuotes();
  return publicQuote(stored);
}

/** Fetch a stored quote by id, or null if unknown/expired. */
function getStoredQuote(id) {
  const q = quotes.get(id);
  if (!q) return null;
  if (q.expiresAt < nowMs()) { quotes.delete(id); return null; }
  return q;
}

module.exports = {
  buildQuote, getStoredQuote, publicQuote, invalidateMarket, invalidateQuotes,
  // pure helpers, exported for tests
  toPackerParams, clampBudget, parseAlgo, marketContext, engineOpts,
  MARKET_TTL_MS, QUOTE_TTL_MS,
};
