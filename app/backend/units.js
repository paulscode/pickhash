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

/*
 * Prices cross the boundary in the unit the marketplace quotes that algorithm in,
 * which is per PH for sha256ab and per TH for blake2b. Internally everything is per
 * TH, so these two are the only places that factor of a thousand should appear.
 *
 * It used to be written as a literal 1e11 (1e8 sats per BTC times 1000 TH per PH)
 * scattered across the pricing paths. That is correct only for an algorithm quoted
 * per PH, and silently a thousandfold wrong for one quoted per TH — in the direction
 * that pays a thousand times over the intended cap.
 */

/** BTC per TH·day -> sats per <unit>·day, for the unit the algorithm is quoted in. */
function satsPerUnitDay(btcThDay, unit) {
  return Number(btcThDay) * perThFactor(unit) * SATS_PER_BTC;
}

/** sats per <unit>·day -> BTC per TH·day. The inverse of satsPerUnitDay. */
function btcThDayFromSatsPerUnitDay(satsUnitDay, unit) {
  return Number(satsUnitDay) / (perThFactor(unit) * SATS_PER_BTC);
}

/** BTC (float) -> satoshis (integer), rounded to the nearest sat. */
function btcToSats(btc) {
  return Math.round(Number(btc) * SATS_PER_BTC);
}

/** satoshis (integer) -> BTC (float). */
function satsToBtc(sats) {
  return Number(sats) / SATS_PER_BTC;
}

module.exports = {
  toTh, fromTh, perThFactor, satsPerUnitDay, btcThDayFromSatsPerUnitDay,
  btcToSats, satsToBtc, HASH_UNIT_TO_HS, HS_PER_TH, SATS_PER_BTC,
};
