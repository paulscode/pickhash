'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../engine/gate');

// A TOPUP_RENT action. Default cost 61,800 sats (base 60,000 + fee 1,800), 100 TH, 3h.
function act(id, { th = 100, paid = 60_000, fee = 1_800, hours = 3 } = {}) {
  return { type: 'TOPUP_RENT', rigId: String(id), advertisedTh: th, lengthHours: hours, paidSats: paid, feeSats: fee };
}
const reasons = (r) => r.blocked.map((b) => b.reason);

// ---- Run mode ----

test('PAUSED blocks everything (no mutation, no rehearsal)', () => {
  const r = gate.gate([act(1), act(2)], { runMode: 'paused' });
  assert.equal(r.authorized.length, 0);
  assert.equal(r.wouldDo.length, 0);
  assert.deepEqual(reasons(r), ['paused', 'paused']);
});

test('DRY-RUN records every budget-feasible action as would-do and mutates nothing', () => {
  const r = gate.gate([act(1), act(2)], { runMode: 'dry-run', sessionBudgetSats: 1_000_000 });
  assert.equal(r.authorized.length, 0, 'no live mutations');
  assert.equal(r.wouldDo.length, 2);
  assert.equal(r.blocked.length, 0);
});

test('LIVE authorizes at most ONE rent per tick (pacing), deferring the rest', () => {
  const r = gate.gate([act(1), act(2), act(3)], { runMode: 'live', sessionBudgetSats: 1_000_000, lastRentAt: 0, now: 10_000 });
  assert.equal(r.authorized.length, 1, 'one rent this tick');
  assert.equal(r.authorized[0].rigId, '1', 'the cheapest-rank action first');
  assert.deepEqual(reasons(r), ['paced', 'paced']);
});

test('LIVE holds off entirely until the pacing interval has elapsed since the last rent', () => {
  const r = gate.gate([act(1)], { runMode: 'live', sessionBudgetSats: 1_000_000, pacingSec: 60, lastRentAt: 10_000, now: 10_030 });
  assert.equal(r.authorized.length, 0, 'only 30s since last rent < 60s pacing');
  assert.deepEqual(reasons(r), ['paced']);
});

test('LIVE authorizes once the pacing interval has passed', () => {
  const r = gate.gate([act(1)], { runMode: 'live', sessionBudgetSats: 1_000_000, pacingSec: 60, lastRentAt: 10_000, now: 10_070 });
  assert.equal(r.authorized.length, 1);
});

// ---- Endpoint halt (mode-independent) ----

test('endpoint_down halts all rents, in LIVE and in DRY-RUN alike', () => {
  for (const runMode of ['live', 'dry-run']) {
    const r = gate.gate([act(1), act(2)], { runMode, endpointDown: true, sessionBudgetSats: 1_000_000, now: 10_000 });
    assert.equal(r.authorized.length, 0);
    assert.equal(r.wouldDo.length, 0);
    assert.deepEqual(reasons(r), ['endpoint_down', 'endpoint_down']);
  }
});

// ---- Budget ceilings (cumulative, cheapest-first) ----

test('the per-session budget stops admissions once cumulative spend would cross it', () => {
  // Three 61,800-sat rigs, session budget 130,000, nothing spent yet -> first two fit, third blocked.
  const r = gate.gate([act(1), act(2), act(3)], { runMode: 'dry-run', sessionBudgetSats: 130_000, sessionSpentSats: 0 });
  assert.equal(r.wouldDo.length, 2);
  assert.deepEqual(reasons(r), ['session_budget']);
  // Already-spent counts toward the ceiling.
  const r2 = gate.gate([act(1)], { runMode: 'dry-run', sessionBudgetSats: 130_000, sessionSpentSats: 100_000 });
  assert.equal(r2.wouldDo.length, 0);
  assert.deepEqual(reasons(r2), ['session_budget']);
});

test('the global max_session_budget ceiling blocks independently of the session budget', () => {
  // Session budget is effectively unbounded, but the global cap is 130,000.
  const r = gate.gate([act(1), act(2), act(3)], { runMode: 'dry-run', maxSessionBudgetSats: 130_000 });
  assert.equal(r.wouldDo.length, 2);
  assert.deepEqual(reasons(r), ['max_session_budget']);
});

test('the rolling max_daily_spend ceiling counts prior 24h spend', () => {
  const r = gate.gate([act(1)], { runMode: 'dry-run', maxDailySpendSats: 100_000, dailySpentSats: 90_000 });
  assert.equal(r.wouldDo.length, 0, '90k + 61.8k > 100k daily cap');
  assert.deepEqual(reasons(r), ['max_daily_spend']);
  // Under the cap -> passes.
  const r2 = gate.gate([act(1)], { runMode: 'dry-run', maxDailySpendSats: 200_000, dailySpentSats: 90_000 });
  assert.equal(r2.wouldDo.length, 1);
});

// ---- Rate ceiling ----

test('the optional rate ceiling blocks rigs priced above it, admits those at/under', () => {
  const a = act('pricey');   // 0.0002 BTC/hr over 100 TH -> 200 sats/TH/hr
  assert.ok(Math.abs(gate.ratePerThHour(a) - 200) < 1e-6);
  const blockedR = gate.gate([a], { runMode: 'dry-run', rateCeilingSatsThHour: 100 });
  assert.deepEqual(reasons(blockedR), ['rate_ceiling']);
  const okR = gate.gate([a], { runMode: 'dry-run', rateCeilingSatsThHour: 300 });
  assert.equal(okR.wouldDo.length, 1);
});

// ---- Dedupe + combined ----

test('at most one action per rig per tick', () => {
  const r = gate.gate([act('5'), act('5')], { runMode: 'dry-run', sessionBudgetSats: 1_000_000 });
  assert.equal(r.wouldDo.length, 1);
  assert.deepEqual(reasons(r), ['dup_rig_tick']);
});

test('a combined scenario reports each block reason', () => {
  const r = gate.gate(
    [act('a'), act('a'), act('b'), act('c')],
    { runMode: 'dry-run', sessionBudgetSats: 130_000, rateCeilingSatsThHour: 500 },
  );
  // a: cleared; a(dup): dup_rig_tick; b: cleared (cum 123.6k); c: over 130k -> session_budget.
  assert.equal(r.wouldDo.length, 2);
  assert.deepEqual(reasons(r).sort(), ['dup_rig_tick', 'session_budget']);
});

test('actionCost sums base + fee', () => {
  assert.equal(gate.actionCost(act(1)), 61_800);
});

// ---- Ceiling boundary: cumulative sum exactly on the ceiling is admitted (the >/>= edge) ----

test('session_budget: landing exactly on the ceiling admits; one sat over blocks', () => {
  // Two 61,800-sat rigs -> cumulative 123,600.
  const at = gate.gate([act(1), act(2)], { runMode: 'dry-run', sessionBudgetSats: 123_600, sessionSpentSats: 0 });
  assert.equal(at.wouldDo.length, 2, 'cumulative exactly at the ceiling is admitted');
  assert.equal(at.blocked.length, 0);
  const over = gate.gate([act(1), act(2)], { runMode: 'dry-run', sessionBudgetSats: 123_599, sessionSpentSats: 0 });
  assert.equal(over.wouldDo.length, 1);
  assert.deepEqual(reasons(over), ['session_budget']);
  // Prior spend counts toward the ceiling at the boundary too.
  const atSpent = gate.gate([act(1)], { runMode: 'dry-run', sessionBudgetSats: 123_600, sessionSpentSats: 61_800 });
  assert.equal(atSpent.wouldDo.length, 1, 'spent + cost exactly on the ceiling admits');
  const overSpent = gate.gate([act(1)], { runMode: 'dry-run', sessionBudgetSats: 123_599, sessionSpentSats: 61_800 });
  assert.deepEqual(reasons(overSpent), ['session_budget']);
});

test('max_session_budget: landing exactly on the ceiling admits; one sat over blocks', () => {
  const at = gate.gate([act(1), act(2)], { runMode: 'dry-run', maxSessionBudgetSats: 123_600 });
  assert.equal(at.wouldDo.length, 2);
  const over = gate.gate([act(1), act(2)], { runMode: 'dry-run', maxSessionBudgetSats: 123_599 });
  assert.equal(over.wouldDo.length, 1);
  assert.deepEqual(reasons(over), ['max_session_budget']);
});

test('max_daily_spend: prior 24h spend + cost exactly on the ceiling admits; one over blocks', () => {
  const at = gate.gate([act(1)], { runMode: 'dry-run', maxDailySpendSats: 123_600, dailySpentSats: 61_800 });
  assert.equal(at.wouldDo.length, 1, 'daily spent + cost exactly at the ceiling admits');
  const over = gate.gate([act(1)], { runMode: 'dry-run', maxDailySpendSats: 123_599, dailySpentSats: 61_800 });
  assert.equal(over.wouldDo.length, 0);
  assert.deepEqual(reasons(over), ['max_daily_spend']);
});

// ---- Cumulative-walk order (cheapest-first prefix, not just count) ----

test('the cumulative walk admits the cheapest-first prefix in order', () => {
  const r = gate.gate([act('a'), act('b'), act('c')], { runMode: 'dry-run', sessionBudgetSats: 123_600 });
  assert.deepEqual(r.wouldDo.map((a) => a.rigId), ['a', 'b'], 'first two admitted in order');
  assert.deepEqual(reasons(r), ['session_budget'], 'the third crosses the ceiling');
});

// ---- Rate ceiling AT the boundary ----

test('a rig priced exactly at the rate ceiling is admitted', () => {
  const a = act('x');
  const rate = gate.ratePerThHour(a);
  const r = gate.gate([a], { runMode: 'dry-run', rateCeilingSatsThHour: rate });
  assert.equal(r.wouldDo.length, 1, 'rate == ceiling is admitted (the > edge)');
});

// ---- Pacing boundary + degenerate rate ----

test('LIVE authorizes when now - lastRentAt exactly equals the pacing interval', () => {
  const r = gate.gate([act(1)], { runMode: 'live', sessionBudgetSats: 1_000_000, pacingSec: 60, lastRentAt: 10_000, now: 10_060 });
  assert.equal(r.authorized.length, 1, 'the guard is strict-less-than, so == authorizes');
});

test('a zero-hour or zero-TH action rates as Infinity and is blocked under any finite ceiling', () => {
  assert.equal(gate.ratePerThHour(act(1, { hours: 0 })), Infinity);
  assert.equal(gate.ratePerThHour(act(1, { th: 0 })), Infinity);
  const r = gate.gate([act(1, { hours: 0 })], { runMode: 'dry-run', rateCeilingSatsThHour: 1e9 });
  assert.deepEqual(reasons(r), ['rate_ceiling']);
});
