'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const health = require('../engine/health');

const MIN = 60 * 1000;
const START = 1_000_000;                     // rental start (ms)
const AFTER_RAMP = START + 16 * MIN;         // past the 15-min ramp grace
const obs = (o) => ({ source: 'mrr', fresh: true, ended: false, ...o });

test('a new rental ramps for the first 15 min regardless of delivery', () => {
  let h = health.initial(START);
  // Even a 0% reading during ramp stays RAMPING (no offline alarm).
  h = health.step(h, obs({ percent: 0, now: START + 5 * MIN }));
  assert.equal(h.state, 'ramping');
  h = health.step(h, obs({ percent: 40, now: START + 14 * MIN }));
  assert.equal(h.state, 'ramping');
});

test('a healthy reading after ramp -> healthy', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98.3, now: AFTER_RAMP }));
  assert.equal(h.state, 'healthy');
  assert.equal(h.changed, true);
});

test('degraded requires the low reading sustained across the debounce window', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98, now: AFTER_RAMP }));       // healthy
  // Now it drops to 85% — arming, not yet degraded.
  h = health.step(h, obs({ percent: 85, now: AFTER_RAMP + 1 * MIN }));
  assert.equal(h.state, 'healthy', 'still healthy while arming');
  h = health.step(h, obs({ percent: 84, now: AFTER_RAMP + 9 * MIN }));
  assert.equal(h.state, 'healthy', 'not yet 10 min below');
  h = health.step(h, obs({ percent: 84, now: AFTER_RAMP + 11 * MIN }));
  assert.equal(h.state, 'degraded', 'tripped after 10 min sustained');
  assert.equal(h.changed, true);
});

test('an API blip (fresh:false) during the debounce does NOT advance the timer', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 80, now: AFTER_RAMP + 1 * MIN }));   // arm belowSince
  const armed = h.belowSince;
  // A blip 9 min later: held, timer unchanged.
  h = health.step(h, obs({ percent: null, fresh: false, now: AFTER_RAMP + 10 * MIN }));
  assert.equal(h.state, 'healthy');
  assert.equal(h.belowSince, armed, 'belowSince not advanced by the blip');
  // A fresh low reading 2 min after the blip: 11 min since arm -> now trips.
  h = health.step(h, obs({ percent: 80, now: AFTER_RAMP + 12 * MIN }));
  assert.equal(h.state, 'degraded');
});

test('a held (unchanged) low average still matures an already-armed degrade timer', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 80, now: AFTER_RAMP + 1 * MIN }));   // fresh -> arm belowSince
  const armed = h.belowSince;
  // The average never refreshes (same 80%, fresh:false), but the rig HAS been below for the
  // whole window — a stuck/dead rig whose value never changes must still alarm.
  h = health.step(h, obs({ percent: 80, fresh: false, now: AFTER_RAMP + 11 * MIN }));
  assert.equal(h.state, 'degraded', 'a persistent known-bad value matures the timer');
  assert.equal(h.belowSince, armed, 'the arm time is preserved, not reset');
});

test('a rig stuck at 0% from its first reading still trips offline (held values ARM and mature)', () => {
  let h = health.initial(START);
  // The real dead-from-start case: a constant-0 rig's average never changes, so resolveSignal
  // marks every post-ramp reading fresh:false (the first 0 was absorbed by the ramp grace).
  // The offline timer must still ARM on a held 0 — a hard-coded fresh:true would hide the bug
  // where a held value can never arm and the rig sits silently "healthy" while dead.
  h = health.step(h, obs({ percent: 0, fresh: false, now: AFTER_RAMP }));            // held 0 -> ARM
  assert.equal(h.offlineSince, AFTER_RAMP, 'offline armed on a held 0');
  assert.notEqual(h.state, 'offline', 'still arming, not yet matured');
  h = health.step(h, obs({ percent: 0, fresh: false, now: AFTER_RAMP + 6 * MIN }));  // held, > 5 min -> trips
  assert.equal(h.state, 'offline', 'a dead-from-start rig alarms rather than sitting silent');
});

test('a held sub-90 value ARMS the degrade timer even if the first low reading is never fresh', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 85, fresh: false, now: AFTER_RAMP }));           // held low -> ARM
  assert.equal(h.belowSince, AFTER_RAMP, 'degrade armed on a held low value');
  h = health.step(h, obs({ percent: 85, fresh: false, now: AFTER_RAMP + 11 * MIN })); // > 10 min -> trips
  assert.equal(h.state, 'degraded');
});

test('a NULL blip (no reading) still never matures a timer, even past the window', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 97, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 1 * MIN }));       // arm offline (fresh)
  const armed = h.offlineSince;
  // A null blip 20 min later must NOT trip offline — we have no reading, so nothing persists.
  h = health.step(h, obs({ percent: null, fresh: false, now: AFTER_RAMP + 21 * MIN }));
  assert.notEqual(h.state, 'offline', 'a blip is not evidence the rig is offline');
  assert.equal(h.offlineSince, armed, 'timer held, not advanced or reset');
});

test('offline (0%) trips after the offline debounce', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 97, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 1 * MIN }));   // arm
  assert.equal(h.state, 'healthy');
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 7 * MIN }));   // >5 min
  assert.equal(h.state, 'offline');
});

test('recovery to >=93% clears timers and returns to healthy', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 80, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 80, now: AFTER_RAMP + 11 * MIN }));
  assert.equal(h.state, 'degraded');
  h = health.step(h, obs({ percent: 96, now: AFTER_RAMP + 12 * MIN }));
  assert.equal(h.state, 'healthy');
  assert.equal(h.belowSince, null);
});

test('an ended rental is ENDED even with a stale high average', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 98, ended: true, now: AFTER_RAMP + 1 * MIN }));
  assert.equal(h.state, 'ended');
});

test('boot rehydration: a persisted degraded rental does not flip to healthy for one tick', () => {
  // Simulate restart: state loaded from DB as degraded, timers reset (belowSince null).
  const rehydrated = { state: 'degraded', belowSince: null, offlineSince: null, startTs: START, changedAt: START };
  // First post-boot reading is in the 90-93 hysteresis band -> holds degraded.
  let h = health.step(rehydrated, obs({ percent: 92, now: AFTER_RAMP + 30 * MIN }));
  assert.equal(h.state, 'degraded', 'held, not flipped to healthy');
  // A blip also holds degraded.
  h = health.step(rehydrated, obs({ percent: null, fresh: false, now: AFTER_RAMP + 30 * MIN }));
  assert.equal(h.state, 'degraded');
  // Only a genuine >=93 recovery flips it.
  h = health.step(rehydrated, obs({ percent: 97, now: AFTER_RAMP + 30 * MIN }));
  assert.equal(h.state, 'healthy');
});

test('a fresh hashgg signal trips degraded on a shorter window than mrr', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98, source: 'hashgg', now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 70, source: 'hashgg', now: AFTER_RAMP + 1 * MIN }));   // arm
  h = health.step(h, obs({ percent: 70, source: 'hashgg', now: AFTER_RAMP + 3 * MIN }));   // 2 min window
  assert.equal(h.state, 'degraded', 'hashgg confirms in ~2 min, faster than mrr 10 min');
});

test('degrade trips at exactly the debounce window (>= boundary, not >)', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 98, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 80, now: AFTER_RAMP + 1 * MIN }));   // arm belowSince
  const armed = h.belowSince;
  // One ms BEFORE the window: still arming.
  h = health.step(h, obs({ percent: 80, now: armed + health.DEGRADE_DEBOUNCE_MS.mrr - 1 }));
  assert.equal(h.state, 'healthy', 'below the window: not yet degraded');
  assert.equal(h.belowSince, armed, 'timer not reset while arming');
  // EXACT equality now - belowSince === window: trips (a `>` regression fails here).
  h = health.step(h, obs({ percent: 80, now: armed + health.DEGRADE_DEBOUNCE_MS.mrr }));
  assert.equal(h.state, 'degraded', 'trips at exactly the degrade window');
});

test('offline trips at exactly the offline debounce window (>= boundary, not >)', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 97, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 1 * MIN }));   // arm offlineSince
  const armed = h.offlineSince;
  h = health.step(h, obs({ percent: 0, now: armed + health.OFFLINE_DEBOUNCE_MS.mrr - 1 }));
  assert.equal(h.state, 'healthy', 'below the offline window: still arming');
  assert.equal(h.offlineSince, armed, 'offline timer not reset while arming');
  h = health.step(h, obs({ percent: 0, now: armed + health.OFFLINE_DEBOUNCE_MS.mrr }));
  assert.equal(h.state, 'offline', 'trips at exactly the offline window');
});

test('an offline rental recovers to healthy at >=93% and clears offlineSince', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 97, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 1 * MIN }));   // arm
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 7 * MIN }));   // > 5 min -> offline
  assert.equal(h.state, 'offline');
  h = health.step(h, obs({ percent: 96, now: AFTER_RAMP + 8 * MIN }));
  assert.equal(h.state, 'healthy', 'a >=93% reading clears offline');
  assert.equal(h.offlineSince, null, 'offlineSince cleared on recovery');
});

test('a 90-93 band reading clears offline arming (holds prior state)', () => {
  let h = health.initial(START);
  h = health.step(h, obs({ percent: 97, now: AFTER_RAMP }));
  h = health.step(h, obs({ percent: 0, now: AFTER_RAMP + 1 * MIN }));   // arm offline
  assert.ok(h.offlineSince != null, 'offline armed');
  // 92% is in the hysteresis band: holds prior state but clears the offline arming timer.
  h = health.step(h, obs({ percent: 92, now: AFTER_RAMP + 2 * MIN }));
  assert.equal(h.offlineSince, null, 'band reading clears offline arming');
  assert.equal(h.state, 'healthy', 'band holds the prior (healthy) state');
});

test('exported threshold constants and initial() shape are pinned', () => {
  assert.equal(health.RAMP_MS, 15 * 60 * 1000);
  assert.equal(health.HEALTHY_PCT, 93);
  assert.equal(health.DEGRADED_PCT, 90);
  assert.deepEqual(health.DEGRADE_DEBOUNCE_MS, { mrr: 10 * 60 * 1000, hashgg: 2 * 60 * 1000 });
  assert.deepEqual(health.OFFLINE_DEBOUNCE_MS, { mrr: 5 * 60 * 1000, hashgg: 1 * 60 * 1000 });
  assert.deepEqual(health.initial(START), {
    state: 'pending', belowSince: null, offlineSince: null, startTs: START, changedAt: START,
  });
});
