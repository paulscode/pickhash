'use strict';
/*
 * MRR authoritative delivery signal.
 *
 * Reads a rental detail (GET /rental/[id]) and extracts the delivered-vs-advertised
 * measurement MRR judges refunds on: `hashrate.average.percent`. Pure.
 *
 * `percent` is the % of advertised hashrate delivered (e.g. "97.5"). We derive delivered
 * TH from percent × advertised (robust — the raw `average.hash` field's unit tracks the
 * rig's advertised unit and can be "0" during ramp), and keep the raw value for evidence.
 */
// Non-finite readings (a non-numeric percent like "N/A" -> NaN) must map to null, NOT NaN: a NaN
// percent would test as "fresh" (NaN !== prevPercent), advance nothing in health but clear its
// arming timers, and write a garbage sample. null is correctly treated as a blip (not fresh).
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** { percent, deliveredTh, rawHash } from a rental detail. */
function readDetail(detail, advertisedTh) {
  const avg = (detail && detail.hashrate && detail.hashrate.average) || {};
  const percent = num(avg.percent);
  const deliveredTh = (percent != null && advertisedTh != null)
    ? advertisedTh * (percent / 100)
    : null;
  return { percent, deliveredTh, rawHash: avg.hash != null ? String(avg.hash) : null };
}

module.exports = { readDetail };
