'use strict';
/**
 * Unit conversions between the rental API's representations and Pickhash's
 * canonical internal units. Every factor lives here so nothing else hand-rolls one.
 *
 * Canonical internal units:
 *   - hashrate: TH/s (float)
 *   - money:    satoshis (integer) — convert BTC <-> sats only at the boundary
 */

// Hashrate unit ladder as a multiplier to reach hash/s. Each step up is x1000.
const HASH_UNIT_TO_HS = {
  hash: 1,
  kh: 1e3,
  mh: 1e6,
  gh: 1e9,
  th: 1e12,
  ph: 1e15,
  eh: 1e18,
};

const HS_PER_TH = 1e12;
const SATS_PER_BTC = 1e8;

/** Convert a hashrate value in the given unit to TH/s. Unit is case-insensitive. */
function toTh(value, unit) {
  const factor = HASH_UNIT_TO_HS[String(unit || '').toLowerCase()];
  if (factor === undefined) throw new Error(`unknown hash unit: ${unit}`);
  return (Number(value) * factor) / HS_PER_TH;
}

/** Convert TH/s to a value in the given unit. */
function fromTh(th, unit) {
  const factor = HASH_UNIT_TO_HS[String(unit || '').toLowerCase()];
  if (factor === undefined) throw new Error(`unknown hash unit: ${unit}`);
  return (Number(th) * HS_PER_TH) / factor;
}

/**
 * How many TH are in one unit of `unit` (e.g. ph -> 1000, th -> 1, mh -> 1e-6).
 * Used to convert a per-unit price into a per-TH price: sha256ab is priced per PH,
 * so priceBtcThDay = priceBtcPerUnitDay / perThFactor('ph').
 */
function perThFactor(unit) {
  const factor = HASH_UNIT_TO_HS[String(unit || '').toLowerCase()];
  if (factor === undefined) throw new Error(`unknown hash unit: ${unit}`);
  return factor / HS_PER_TH;
}

/** BTC (float) -> satoshis (integer), rounded to the nearest sat. */
function btcToSats(btc) {
  return Math.round(Number(btc) * SATS_PER_BTC);
}

/** satoshis (integer) -> BTC (float). */
function satsToBtc(sats) {
  return Number(sats) / SATS_PER_BTC;
}

module.exports = { toTh, fromTh, perThFactor, btcToSats, satsToBtc, HASH_UNIT_TO_HS, HS_PER_TH, SATS_PER_BTC };
