'use strict';
/*
 * Rental health state machine (pure). One `step()` per observation per rental.
 *
 * States: pending -> ramping -> healthy | degraded | offline -> ended.
 *
 * Design points:
 *   - RAMPING for the first 15 min after start — no degraded/offline alarms (MRR's own
 *     "contact support after 15 min" threshold).
 *   - Wall-clock debounce over *fresh* observations: a transition to degraded/offline
 *     requires the bad reading to persist a real duration. A stale/held average or an API
 *     blip (`fresh:false`) never advances a timer — it holds the current state.
 *   - Hysteresis: enter HEALTHY at >=93%, enter DEGRADED at <90% (sustained); the 90-93%
 *     band holds the prior state so a rig hovering near 90 doesn't flap. The 93% healthy
 *     line matches MRR's auto-refund threshold (a rig at/above it is not under-delivered).
 *   - The debounce window depends on the signal `source`: MRR's lagging average needs a
 *     long window; a future HashGG fast signal can trip faster. v1 always passes 'mrr'.
 *   - `now`/`fresh` are passed in, so this is fully deterministic and testable.
 */

const RAMP_MS = 15 * 60 * 1000;
const HEALTHY_PCT = 93;   // enter HEALTHY at/above this (matches MRR's 93% auto-refund line)
const DEGRADED_PCT = 90;  // enter DEGRADED below this (sustained)

// Wall-clock debounce per source. MRR's average lags, so it needs minutes; a fresh
// per-worker signal (post-v1 hashgg) can confirm in ~2 min.
const DEGRADE_DEBOUNCE_MS = { mrr: 10 * 60 * 1000, hashgg: 2 * 60 * 1000 };
const OFFLINE_DEBOUNCE_MS = { mrr: 5 * 60 * 1000, hashgg: 1 * 60 * 1000 };

const degradeWindow = (source) => DEGRADE_DEBOUNCE_MS[source] != null ? DEGRADE_DEBOUNCE_MS[source] : DEGRADE_DEBOUNCE_MS.mrr;
const offlineWindow = (source) => OFFLINE_DEBOUNCE_MS[source] != null ? OFFLINE_DEBOUNCE_MS[source] : OFFLINE_DEBOUNCE_MS.mrr;

/** A fresh, initial health record for a rental that starts at `startTs` (ms). */
function initial(startTs) {
  return { state: 'pending', belowSince: null, offlineSince: null, startTs, changedAt: startTs };
}

function result(prev, state, patch, now) {
  const changed = state !== prev.state;
  return {
    state,
    belowSince: patch.belowSince !== undefined ? patch.belowSince : prev.belowSince,
    offlineSince: patch.offlineSince !== undefined ? patch.offlineSince : prev.offlineSince,
    startTs: prev.startTs,
    changed,
    changedAt: changed ? now : prev.changedAt,
  };
}

/**
 * Advance one rental's health.
 * @param {object} prev  previous health record (see initial())
 * @param {object} obs   { percent, source, fresh, now, ended }
 *   - percent: MRR-authoritative % delivered (null on a blip)
 *   - source:  'mrr' (v1) | 'hashgg'
 *   - fresh:   true only for a real, changed reading this tick
 *   - now:     ms timestamp
 *   - ended:   rental has ended
 * @returns updated health record with `changed`/`changedAt`
 */
function step(prev, obs) {
  const now = obs.now;

  // Terminal: an ended rental is ENDED regardless of any lagging average (don't
  // trust a stale average for a non-active rental).
  if (obs.ended) return result(prev, 'ended', { belowSince: null, offlineSince: null }, now);

  // Ramp grace: no alarms in the first 15 min.
  if (now < prev.startTs + RAMP_MS) {
    return result(prev, 'ramping', { belowSince: null, offlineSince: null }, now);
  }

  // Non-fresh readings, after ramp:
  //  - A true blip (percent == null: an API failure, no reading) holds everything — state
  //    AND the debounce timers — so a transient outage can't advance or reset a transition.
  //  - A HELD known value (same percent, so `fresh` is false) means the condition genuinely
  //    persists. A rig stuck at a constant 0%/low value is never "fresh" again (its average
  //    doesn't change, and the first bad reading is usually absorbed by the ramp grace), so
  //    the timer must be able to ARM *and* MATURE on these held values — otherwise a dead
  //    rig would never trip offline/degraded. A held value never CLEARS a timer or recovers
  //    state; only a fresh reading does that (recovery must be on real, current data).
  if (!obs.fresh) {
    const heldState = prev.state === 'pending' ? 'ramping' : prev.state;
    if (obs.percent == null) return result(prev, heldState, {}, now);   // blip: hold everything
    if (obs.percent <= 0) {
      const offlineSince = prev.offlineSince != null ? prev.offlineSince : now;
      if (now - offlineSince >= offlineWindow(obs.source)) return result(prev, 'offline', { offlineSince, belowSince: null }, now);
      return result(prev, heldState, { offlineSince, belowSince: null }, now);
    }
    if (obs.percent < DEGRADED_PCT) {
      const belowSince = prev.belowSince != null ? prev.belowSince : now;
      if (now - belowSince >= degradeWindow(obs.source)) return result(prev, 'degraded', { belowSince, offlineSince: null }, now);
      return result(prev, heldState, { belowSince, offlineSince: null }, now);
    }
    // Held value in the healthy/hysteresis band (>=90%): hold state, leave timers untouched.
    return result(prev, heldState, {}, now);
  }

  const pct = obs.percent;

  // Offline: no delivery. Arm a timer; confirm after the offline debounce.
  if (pct == null || pct <= 0) {
    const offlineSince = prev.offlineSince != null ? prev.offlineSince : now;
    if (now - offlineSince >= offlineWindow(obs.source)) {
      return result(prev, 'offline', { offlineSince, belowSince: null }, now);
    }
    return result(prev, prev.state, { offlineSince, belowSince: null }, now); // arming
  }

  // Delivering: clear any offline arming.
  if (pct >= HEALTHY_PCT) {
    return result(prev, 'healthy', { belowSince: null, offlineSince: null }, now);
  }

  if (pct < DEGRADED_PCT) {
    const belowSince = prev.belowSince != null ? prev.belowSince : now;
    if (now - belowSince >= degradeWindow(obs.source)) {
      return result(prev, 'degraded', { belowSince, offlineSince: null }, now);
    }
    return result(prev, prev.state, { belowSince, offlineSince: null }, now); // arming
  }

  // Hysteresis band 90-93%: hold prior state (a first-post-ramp reading here counts as
  // healthy — it's delivering >=90%), clear the below-90 arming timer.
  const held = (prev.state === 'pending' || prev.state === 'ramping') ? 'healthy' : prev.state;
  return result(prev, held, { belowSince: null, offlineSince: null }, now);
}

module.exports = {
  step, initial,
  RAMP_MS, HEALTHY_PCT, DEGRADED_PCT, DEGRADE_DEBOUNCE_MS, OFFLINE_DEBOUNCE_MS,
};
