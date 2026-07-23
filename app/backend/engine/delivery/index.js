'use strict';
/*
 * DeliverySource abstraction.
 *
 * Two roles that must never be conflated:
 *   - authoritative — MRR's `average.percent`. The ONLY basis for money decisions
 *     (disputes, refunds, effective-cost accounting, RigScore). Always available.
 *   - fast — a near-real-time per-worker signal used only to make health/alerts more
 *     responsive. In v1 there is no fast source, so fast === authoritative.
 *
 * The future HashGG per-worker source (scenario 1 + upgraded HashGG) slots in here by
 * setting `fast`/`source` without touching decide/gate/accounting. v1 is MRR-only.
 *
 * Pure: data in -> signal out. `fresh` means we got a real, changed reading this tick —
 * an API blip (null) or an average that hasn't refreshed (identical value) is NOT fresh,
 * so the health debounce never advances on held/stale data.
 */
const mrr = require('./mrr-source');

/**
 * @param {object} args
 * @param {object|null} args.detail        MRR rental detail (GET /rental/[id]) or null on a fetch blip
 * @param {number|null} args.advertisedTh  the rental's advertised TH/s
 * @param {number|null} args.prevPercent   the previous observed percent for this rental
 * @param {number}      args.now           tick timestamp (seconds)
 * @returns {{authoritative:number|null, fast:number|null, deliveredTh:number|null, source:'mrr', fresh:boolean, ts:number}}
 */
function resolveSignal({ detail, advertisedTh, prevPercent, now }) {
  const { percent, deliveredTh } = mrr.readDetail(detail, advertisedTh);
  // v1: no fast source. When HashGG per-worker lands, `fast`/`source` come from it here.
  const fresh = percent != null && percent !== prevPercent;
  return {
    authoritative: percent,
    fast: percent,
    deliveredTh,
    source: 'mrr',
    fresh,
    ts: now,
  };
}

module.exports = { resolveSignal };
