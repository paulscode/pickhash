'use strict';
/*
 * Choosing the share difficulty a rented rig should run at, and expressing it in the
 * one field a marketplace rental lets us set: the Stratum password.
 *
 * Why this exists. MRR judges a rental by the hashrate it observes, and it observes it
 * from accepted shares. A rig running at a difficulty far above its size produces very
 * few shares, so the measurement gets noisy, short rentals can deliver almost none at
 * all, and a refund claim on a rental that really did work gets declined. The fix is to
 * put each rig at a difficulty suited to its own hashrate.
 *
 * We cannot do that through the protocol. The `minimum-difficulty` extension of
 * mining.configure is sent by the MINER, and these are third-party rigs whose firmware
 * we do not control. The password is the only field MRR passes through to the pool
 * verbatim, so that is the channel.
 *
 * The value comes from MRR's own `optimal_diff` on the rig record rather than from
 * arithmetic on the advertised hashrate. Every rig publishes it (measured 2026-09-01:
 * 1581/1581 sha256ab and 7/7 blake2b), and it is the range MRR's own scoring expects,
 * which matters when their measurement is what decides the refund.
 *
 * See doc/passwords.md in the DATUM Gateway fork for the receiving end.
 */

// Difficulty is only meaningful to vardiff in powers of two: it steps by halving and
// doubling, and the gateway rounds a request DOWN to one. Rounding down here instead
// would land below optimal_diff.min, so this rounds up and the range check below
// catches the rare band too narrow to contain a power of two.
const MAX_DIFF = 2 ** 48;

/** Smallest power of two >= n, or null if n is not a usable positive number. */
function powerOfTwoAtLeast(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0 || v > MAX_DIFF) return null;
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/**
 * The difficulty to ask this rig to run at, or null to leave it to the pool.
 *
 * Anchored at optimal_diff.min rather than the middle of the band: that is the busiest
 * end MRR still calls optimal, and more shares is what makes their hashrate reading
 * less noisy. Returns null when the rig publishes no range, or when the band is
 * narrower than a factor of two and so contains no power of two at all.
 */
function chooseDiff(rig) {
  const od = rig && rig.optimalDiff;
  if (!od) return null;
  const min = Number(od.min);
  const max = Number(od.max);
  if (!Number.isFinite(min) || min <= 0) return null;
  const d = powerOfTwoAtLeast(min);
  if (d == null) return null;
  if (Number.isFinite(max) && max > 0 && d > max) return null;
  return d;
}

/**
 * The Stratum password carrying a difficulty request, or 'x' for none.
 *
 * 'x' is what this sent before the feature existed and is the near-universal filler, so
 * a pool that does not understand the request is unaffected either way: DATUM discards
 * an unrecognised password rather than erroring on it.
 */
function password(diff) {
  const d = Number(diff);
  if (!Number.isFinite(d) || d <= 0) return 'x';
  return `d=${Math.floor(d)}`;
}

/** The password for a rig in one step. 'x' when the rig publishes nothing usable. */
function passwordForRig(rig) {
  return password(chooseDiff(rig));
}

/**
 * A password that asks for a difficulty the endpoint would not otherwise be using, for
 * probing whether it honours the request at all. Asking HIGHER than the observed
 * default keeps this safe to send: the gateway's floors only ever clamp a request
 * upward, so a raise is never refused for being out of bounds, and a false negative is
 * not possible from a clamp. Null when there is no observed default to differ from.
 */
function probeDiff(observedDiff) {
  const d = Number(observedDiff);
  if (!Number.isFinite(d) || d <= 0) return null;
  const p = powerOfTwoAtLeast(d);
  if (p == null) return null;
  const raised = p * 4;
  return raised > MAX_DIFF ? null : raised;
}

module.exports = { powerOfTwoAtLeast, chooseDiff, password, passwordForRig, probeDiff, MAX_DIFF };
