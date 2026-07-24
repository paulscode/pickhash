'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const decide = require('../engine/decide');
const session = require('../session');

// A normalized market rig (market.normalizeRig shape) that passes autopilot eligibility:
// available/online/pool-online, BTC enabled, rpi ok, and perfectly stable (measured==advertised).
function rig(id, { th = 100, hourBtc = 0.0002, minHours = 3, maxHours = 96, rpi = 95 } = {}) {
  return {
    id: String(id), name: `rig-${id}`, owner: `o${id}`, region: 'us',
    advertisedTh: th, hourBtc, priceBtcThDay: (hourBtc * 24) / th,
    measuredTh: { m5: th, m15: th, m30: th },   // stabilityPct 0 -> autopilot-eligible
    minHours, maxHours, minRentalLength: minHours, rpi,
    priceEnabled: true, available: true, online: true, poolstatus: 'online',
    rented: false, status: 'available', optimalDiff: null,
  };
}

function sess(over = {}) {
  return { mode: 'autopilot', state: 'active', target_th: 300, budget_sats: 1_000_000, time_cap_hours: 168, spent_sats: 0, started_at: 1000, ...over };
}

const ctx = (over = {}) => ({ now: 1000, fetchOk: true, hashrateTolerancePct: 5, minRpi: 90, ...over });

// ---- packToTarget: shared overshoot-bounded packer (decide + the Autopilot estimate) ----

const pack = (feasible, needed, over = {}) =>
  decide.packToTarget(feasible, needed, { fitTol: 0.2, maxOvershoot: 1, budgetRemaining: Infinity, costOf: () => 0, ...over });

test('packToTarget accumulates smaller rigs then closes the gap within fitTol', () => {
  const r = pack([rig('a', { th: 100 }), rig('b', { th: 100 }), rig('c', { th: 100 })], 300);
  assert.equal(r.selection.length, 3);
  assert.equal(r.coveredTh, 300);
});

test('packToTarget does NOT over-provision a small target with a giant rig (the preview bug)', () => {
  // Only a 1000 TH rig for a 200 TH target: overshoot 800 > 200*maxOvershoot -> take nothing,
  // leave a bounded shortfall. The old greedy rented the giant rig and reported "holding" 1000 TH.
  const r = pack([rig('big', { th: 1000 })], 200);
  assert.equal(r.selection.length, 0);
  assert.equal(r.coveredTh, 0);
});

test('packToTarget accepts a best-fit rig that overshoots within maxOvershoot', () => {
  // 300 TH for a 200 target overshoots by 100 (== 200*0.5, within the ceiling) -> allowed.
  const r = pack([rig('x', { th: 300 })], 200);
  assert.equal(r.selection.length, 1);
  assert.equal(r.coveredTh, 300);
});

test('packToTarget stops when the next rig would exceed the budget', () => {
  const r = pack([rig('a', { th: 100 }), rig('b', { th: 100 }), rig('c', { th: 100 })], 300,
    { budgetRemaining: 150, costOf: () => 100 });
  assert.equal(r.selection.length, 1);   // first costs 100; a second (200) exceeds the 150 budget
  assert.equal(r.coveredTh, 100);
});

test('packToTarget closes with the cheapest rig to HOLD, not the best per-TH rank', () => {
  // Both fit the 100 TH gap within fitTol. rankFirst has the better per-TH rate (sorts first) but a
  // higher ABSOLUTE hold-rate; the closer is paid in full, so it must pick the cheaper-to-hold rig.
  const rankFirst = rig('rankFirst', { th: 120, hourBtc: 0.0011 });   // per-TH 9.2e-6 (ranks first)
  const cheapHold = rig('cheapHold', { th: 100, hourBtc: 0.0010 });   // pricier per-TH, cheaper to hold
  const r = pack([rankFirst, cheapHold], 100);
  assert.deepEqual(r.selection.map((x) => x.id), ['cheapHold']);
});

test('packToTarget overshoot-closer minimizes hold cost, not overshoot', () => {
  // Neither fits within fitTol (both > 120 for a 100 gap). Min-overshoot would grab tightFit (130);
  // bigCheap (150) is cheaper to hold and still within maxOvershoot, so it wins.
  const tightFit = rig('tightFit', { th: 130, hourBtc: 0.0013 });
  const bigCheap = rig('bigCheap', { th: 150, hourBtc: 0.0010 });
  const r = pack([tightFit, bigCheap], 100);
  assert.deepEqual(r.selection.map((x) => x.id), ['bigCheap']);
  assert.equal(r.coveredTh, 150);
});

// ---- Gating: who tops up ----

test('a quick session never tops up', () => {
  const r = decide.decide(ctx({ session: sess({ mode: 'quick' }), rentals: [], marketRigs: [rig(1)] }));
  assert.equal(r.actions.length, 0);
  assert.ok(r.notes.includes('not_autopilot'));
});

test('a non-active autopilot session never tops up', () => {
  const r = decide.decide(ctx({ session: sess({ state: 'ended' }), rentals: [], marketRigs: [rig(1)] }));
  assert.equal(r.actions.length, 0);
});

test('a failed rentals fetch this tick blocks all top-up (duplicate-order guard)', () => {
  // Big gap, plenty of budget/market — but fetchOk:false must veto any rent.
  const r = decide.decide(ctx({ fetchOk: false, session: sess(), rentals: [], marketRigs: [rig(1), rig(2), rig(3)] }));
  assert.equal(r.actions.length, 0);
  assert.ok(r.notes.includes('fetch_not_ok'));
});

test('at/after the time cap it stops opening new rentals (never cancels paid time)', () => {
  const s = sess({ target_th: 300, time_cap_hours: 10, started_at: 1000 });
  const now = 1000 + 11 * 3600;   // 11h elapsed on a 10h cap
  const r = decide.decide(ctx({ now, session: s, rentals: [], marketRigs: [rig(1), rig(2), rig(3)] }));
  assert.equal(r.actions.length, 0);
  assert.ok(r.notes.includes('time_cap_reached'));
});

// ---- Trigger band ----

test('within the tolerance band it proposes nothing', () => {
  // target 100, one healthy rig delivering ~advertised -> active 100 >= 95 -> hold.
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: 100, delivered_th: 98, health: 'healthy', ended: 0 }], marketRigs: [rig(1)] }));
  assert.equal(r.actions.length, 0);
  assert.ok(r.notes.includes('within_tolerance'));
});

test('below the tolerance band it tops up to cover the gap, cheapest rank first', () => {
  // target 300, one healthy 100 TH rig held -> need 200 -> pick the two cheapest of three.
  const s = sess({ target_th: 300 });
  const rentals = [{ rig_id: 9, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 0 }];
  const market = [rig('cheap', { hourBtc: 0.0001 }), rig('mid', { hourBtc: 0.0002 }), rig('dear', { hourBtc: 0.0003 })];
  const r = decide.decide(ctx({ session: s, rentals, marketRigs: market }));
  assert.equal(r.actions.length, 2, 'two rigs to cover the 200 TH gap');
  assert.deepEqual(r.actions.map((a) => a.rigId), ['cheap', 'mid'], 'cheapest rank first');
  assert.ok(r.actions.every((a) => a.type === 'TOPUP_RENT' && a.advertisedTh === 100));
});

// ---- Contribution accounting (ramp vs confirmed underdelivery) ----

test('a rig still ramping counts at advertised, so we do NOT over-rent during ramp', () => {
  // Freshly rented 100 TH rig, health pending, has delivered nothing yet.
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: 100, delivered_th: 0, health: 'pending', ended: 0 }], marketRigs: [rig(1)] }));
  assert.equal(r.actions.length, 0, 'ramping rig still counts full -> no top-up');
  assert.ok(r.notes.includes('within_tolerance'));
});

test('a CONFIRMED degraded rig counts at its measured delivery, triggering a top-up for the gap', () => {
  // 100 TH rig confirmed degraded, only delivering 40 -> active 40 < 95 -> need 60 -> one rig.
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: 100, delivered_th: 40, health: 'degraded', ended: 0 }], marketRigs: [rig('x', { th: 100 })] }));
  assert.equal(r.actions.length, 1);
  assert.ok(Math.abs(r.activeTh - 40) < 1e-9);
});

// ---- Exclusions & feasibility ----

test('a rig we already hold is never re-rented', () => {
  const s = sess({ target_th: 200 });
  const rentals = [{ rig_id: 5, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 0 }];
  // Market still lists rig 5 (as if available) plus rig 6; only 6 may be picked.
  const r = decide.decide(ctx({ session: s, rentals, marketRigs: [rig('5'), rig('6')] }));
  assert.deepEqual(r.actions.map((a) => a.rigId), ['6']);
});

test('a rig whose min length exceeds the remaining window is excluded', () => {
  const s = sess({ target_th: 100, time_cap_hours: 2, started_at: 1000 });   // 2h window
  const r = decide.decide(ctx({ now: 1000, session: s, rentals: [], marketRigs: [rig('x', { minHours: 3 })] }));
  assert.equal(r.actions.length, 0, 'min 3h > 2h window');
  assert.ok(r.notes.includes('no_affordable_candidate'));
  assert.ok(r.shortfallTh > 0);
});

test('a rig whose min commit cost exceeds the remaining budget is excluded', () => {
  // budget almost spent: only 100 sats left, but a rig min-commit is ~61.8k sats.
  const s = sess({ target_th: 100, budget_sats: 1000, spent_sats: 900 });
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [rig('x')] }));
  assert.equal(r.actions.length, 0);
  assert.ok(r.notes.includes('no_affordable_candidate'));
});

// ---- Budget safety + shortfall ----

test('proposed spend never exceeds the remaining budget (partial fill + shortfall)', () => {
  // need 300 TH (3 rigs) but budget only affords one min-commit (~61.8k sats).
  const s = sess({ target_th: 300, budget_sats: 70_000, spent_sats: 0 });
  const market = [rig('a'), rig('b'), rig('c')];
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: market }));
  const spend = r.actions.reduce((x, a) => x + a.paidSats + a.feeSats, 0);
  assert.ok(spend <= 70_000, `spend ${spend} <= budget`);
  assert.equal(r.actions.length, 1, 'only one rig fits the budget');
  assert.ok(r.shortfallTh > 0 && r.notes.includes('shortfall'));
});

test('too few eligible rigs -> partial selection + shortfall, never a block', () => {
  const s = sess({ target_th: 300 });
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [rig('only', { th: 100 })] }));
  assert.equal(r.actions.length, 1);
  assert.ok(Math.abs(r.shortfallTh - 200) < 1e-9);
  assert.ok(r.notes.includes('shortfall'));
});

test('property: across budgets, proposed fee-inclusive spend never crosses the remaining budget', () => {
  const market = Array.from({ length: 8 }, (_, i) => rig(`r${i}`, { hourBtc: 0.0001 + i * 0.00003 }));
  for (const budget of [0, 30_000, 61_800, 120_000, 250_000, 999_999]) {
    const s = sess({ target_th: 800, budget_sats: budget, spent_sats: 0 });
    const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: market }));
    const spend = r.actions.reduce((x, a) => x + a.paidSats + a.feeSats, 0);
    assert.ok(spend <= budget, `budget ${budget}: spend ${spend} must not exceed it`);
  }
});

// ---- Cost/rate helpers ----

test('rentCostSats reproduces MRR per-rental fee rounding', () => {
  const c = decide.rentCostSats(0.0002, 3);   // base = round(0.0002*3*1e8) = 60000
  assert.equal(c.base, 60_000);
  assert.equal(c.fee, 1_800);                  // round(60000 * 0.03)
  assert.equal(c.total, 61_800);
});

test('rateCapPhDay matches session.rateCapPhDay for the same per-TH price', () => {
  const r = rig('x', { th: 100, hourBtc: 0.0002 });   // priceBtcThDay = 0.0002*24/100 = 4.8e-5
  assert.equal(decide.rateCapPhDay(r), session.rateCapPhDay(r.priceBtcThDay));
});

test('each proposed action carries a protective rate cap and its own length', () => {
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [rig('x', { minHours: 6 })] }));
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].lengthHours, 6);
  assert.ok(r.actions[0].rateCapPhDay > 0);
});

// ---- Tolerance-band boundary (the >= edge) ----

test('exactly at the trigger threshold holds; one TH below it tops up', () => {
  // target 100, tol 5% -> threshold = 100*(1-0.05). active == threshold is within tolerance (>=).
  const s = sess({ target_th: 100 });
  const thresh = 100 * (1 - 5 / 100);
  const at = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: thresh, delivered_th: thresh, health: 'healthy', ended: 0 }], marketRigs: [rig(1)] }));
  assert.equal(at.actions.length, 0, 'active exactly at target*(1-tol) is within tolerance');
  assert.ok(at.notes.includes('within_tolerance'));
  assert.ok(Math.abs(at.activeTh - thresh) < 1e-9);
  // One unit below the threshold -> a real gap. With a well-fit rig available it tops up.
  const below = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: thresh - 1, delivered_th: thresh - 1, health: 'healthy', ended: 0 }], marketRigs: [rig('fit', { th: 6 })] }));
  assert.ok(below.neededTh > 0 && !below.notes.includes('within_tolerance'), 'one TH under the threshold registers a real gap');
  assert.equal(below.actions.length, 1, 'a fitting rig tops it up');
  assert.equal(below.actions[0].type, 'TOPUP_RENT');
});

// ---- Best-fit top-up sizing (fit tolerance + max-overshoot ceiling) ----

test('a small gap is NOT filled by a hugely-oversized rig — bounded shortfall + retry instead', () => {
  // Hold 309 of a 400 target -> gap 91. Only a 445 TH rig exists (+389% overshoot). Must decline.
  const s = sess({ target_th: 400 });
  const rentals = [{ rig_id: 9, advertised_th: 309, delivered_th: 309, health: 'healthy', ended: 0 }];
  const r = decide.decide(ctx({ session: s, rentals, marketRigs: [rig('big', { th: 445 })] }));
  assert.equal(r.actions.length, 0, 'no gross over-provision for a small gap');
  assert.ok(r.notes.includes('no_fit'));
  assert.ok(Math.abs(r.shortfallTh - 91) < 1e-9, 'the gap is left as a bounded shortfall');
});

test('best-fit takes a smaller rig then leaves the residual as a shortfall (note shortfall, not no_fit)', () => {
  // gap 100: no fit, take the 70 (partial, no overshoot); residual 30 can only be closed by the
  // 200 (+567% overshoot) -> left as a shortfall. Selection is non-empty, so the note is 'shortfall'.
  const s = sess({ target_th: 100 });
  const market = [rig('small', { th: 70, hourBtc: 0.0001 }), rig('huge', { th: 200, hourBtc: 0.0002 })];
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: market }));
  assert.deepEqual(r.actions.map((a) => a.rigId), ['small'], 'takes the 70 TH partial (no overshoot)');
  assert.ok(Math.abs(r.shortfallTh - 30) < 1e-9, 'residual 30 TH left, not filled by the oversized 200');
  assert.ok(r.notes.includes('shortfall') && !r.notes.includes('no_fit'), 'non-empty selection -> shortfall, not no_fit');
});

test('within the fit tolerance, the cheapest-rank rig among the fits is chosen', () => {
  // gap 100; three rigs cover it within +20% (100..120): pick the cheapest rank, not the smallest.
  const s = sess({ target_th: 100 });
  const market = [
    rig('cheapBig', { th: 118, hourBtc: 0.0001 }),   // cheapest, +18% (a fit)
    rig('dearExact', { th: 100, hourBtc: 0.0003 }),  // exact fit but pricier
  ];
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: market }));
  assert.deepEqual(r.actions.map((a) => a.rigId), ['cheapBig'], 'cheapest-rank among fitting rigs, not tightest fit');
});

test('between fit tolerance and the ceiling, the cheapest-to-hold rig wins (even with more overshoot)', () => {
  // gap 100; no rig within +20%, but two within the +100% ceiling. The closer is paid in full, so the
  // cheaper-to-HOLD rig wins even though it overshoots more — you get >= the gap for less ongoing spend.
  const s = sess({ target_th: 100 });
  const market = [
    rig('cheapHuge', { th: 190, hourBtc: 0.0001 }),  // +90% overshoot but 3x cheaper to hold
    rig('dearClose', { th: 130, hourBtc: 0.0003 }),  // +30% overshoot but 3x the hold cost
  ];
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: market }));
  assert.deepEqual(r.actions.map((a) => a.rigId), ['cheapHuge'], 'min hold-cost beats min-overshoot within the ceiling');
});

test('a raised max_overshoot_pct lets a big rig fill a small gap (firm-floor policy)', () => {
  // Same 91-gap case, but max_overshoot 500% -> the 445 rig (+389%) is now accepted.
  const s = sess({ target_th: 400 });
  const rentals = [{ rig_id: 9, advertised_th: 309, delivered_th: 309, health: 'healthy', ended: 0 }];
  const r = decide.decide(ctx({ session: s, rentals, marketRigs: [rig('big', { th: 445 })], maxOvershootPct: 500 }));
  assert.deepEqual(r.actions.map((a) => a.rigId), ['big'], 'a lenient ceiling fills the gap even with overshoot');
});

// ---- Replace lookahead (overlap the ramp dead-time before a rig cliffs at end_ts) ----

test('contributionTh: a healthy rig inside the replace-lead window counts as 0; outside it counts advertised', () => {
  const r = { advertised_th: 300, delivered_th: 300, health: 'healthy', end_ts: 1000 };
  assert.equal(decide.contributionTh(r, { now: 699, replaceLeadSec: 300 }), 300, '301s to end (> lead) -> counted');
  assert.equal(decide.contributionTh(r, { now: 700, replaceLeadSec: 300 }), 0, 'exactly at the lead edge -> counted as gone');
  assert.equal(decide.contributionTh(r, { now: 0, replaceLeadSec: 300 }), 300, 'far from end -> advertised');
  assert.equal(decide.contributionTh(r, {}), 300, 'no lead context -> advertised (default unchanged)');
  // A confirmed-bad rig is always its measured delivery, lead window or not.
  assert.equal(decide.contributionTh({ health: 'degraded', delivered_th: 40, advertised_th: 100, end_ts: 1000 }, { now: 800, replaceLeadSec: 300 }), 40);
});

test('the replace-lookahead opens the gap early: a healthy rig near its end triggers a replacement rent', () => {
  const s = sess({ target_th: 300 });
  // Held rig delivering a full 300, but it ends in 200s (inside a 300s lead) -> counts as gone.
  const rentals = [{ rig_id: 9, advertised_th: 300, delivered_th: 300, health: 'healthy', ended: 0, end_ts: 1200 }];
  const near = decide.decide(ctx({ now: 1000, session: s, rentals, replaceLeadSec: 300, marketRigs: [rig('repl', { th: 300 })] }));
  assert.ok(Math.abs(near.activeTh) < 1e-9, 'the departing rig is discounted to 0');
  assert.deepEqual(near.actions.map((a) => a.rigId), ['repl'], 'a replacement is proposed while the old rig still runs');
  // The same rig NOT near its end -> counted full -> within tolerance -> no early rent.
  const far = decide.decide(ctx({ now: 1000, session: s, rentals: [{ ...rentals[0], end_ts: 100000 }], replaceLeadSec: 300, marketRigs: [rig('repl', { th: 300 })] }));
  assert.equal(far.actions.length, 0, 'not near end -> no early replacement');
});

test('the replace-lookahead does NOT runaway-rent: once the replacement is held, it is within tolerance', () => {
  const s = sess({ target_th: 300 });
  const rentals = [
    { rig_id: 9, advertised_th: 300, delivered_th: 300, health: 'healthy', ended: 0, end_ts: 1200 },      // departing (within lead) -> 0
    { rig_id: 10, advertised_th: 300, delivered_th: 100, health: 'pending', ended: 0, end_ts: 100000 },   // the fresh replacement, ramping -> counts advertised 300
  ];
  const r = decide.decide(ctx({ now: 1000, session: s, rentals, replaceLeadSec: 300, marketRigs: [rig('x', { th: 300 })] }));
  assert.ok(Math.abs(r.activeTh - 300) < 1e-9, 'departing 0 + replacement 300 -> at target');
  assert.equal(r.actions.length, 0, 'within tolerance -> no SECOND replacement (no runaway)');
});

test('the replace-lookahead with no available replacement leaves a shortfall (graceful, old rig still runs)', () => {
  const s = sess({ target_th: 300 });
  const rentals = [{ rig_id: 9, advertised_th: 300, delivered_th: 300, health: 'healthy', ended: 0, end_ts: 1200 }];
  const r = decide.decide(ctx({ now: 1000, session: s, rentals, replaceLeadSec: 300, marketRigs: [] }));
  assert.ok(Math.abs(r.activeTh) < 1e-9, 'departing rig discounted to 0');
  assert.equal(r.actions.length, 0, 'empty market -> nothing to rent');
  assert.ok(r.notes.includes('no_affordable_candidate') && r.shortfallTh > 0);
});

// ---- Remaining health states (offline like degraded, ramping like pending) ----

test('a CONFIRMED offline rig counts at its measured delivery, triggering a top-up', () => {
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: 100, delivered_th: 40, health: 'offline', ended: 0 }], marketRigs: [rig('x', { th: 100 })] }));
  assert.equal(r.actions.length, 1);
  assert.ok(Math.abs(r.activeTh - 40) < 1e-9, 'offline contributes delivered, not advertised');
});

test('a ramping rig counts at advertised, so we do NOT over-rent during ramp', () => {
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [{ rig_id: 9, advertised_th: 100, delivered_th: 0, health: 'ramping', ended: 0 }], marketRigs: [rig(1)] }));
  assert.equal(r.actions.length, 0, 'ramping counts full advertised -> no top-up');
  assert.ok(r.notes.includes('within_tolerance'));
});

// ---- The !r.ended active filter ----

test('an ended rental is excluded from activeTh and is re-rentable (not held)', () => {
  const s = sess({ target_th: 200 });
  const rentals = [
    { rig_id: 5, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 0 },
    { rig_id: 7, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 1 },   // expired
  ];
  const r = decide.decide(ctx({ session: s, rentals, marketRigs: [rig('7', { hourBtc: 0.0001 }), rig('8', { hourBtc: 0.0002 })] }));
  assert.ok(Math.abs(r.activeTh - 100) < 1e-9, 'only the non-ended rental contributes');
  assert.deepEqual(r.actions.map((a) => a.rigId), ['7'], 'the ended rig is not held -> re-rentable (and cheapest)');
});

// ---- Action telemetry fields ----

test('an emitted action carries the full diff/rate telemetry (with in-range diff)', () => {
  const s = sess({ target_th: 100 });
  const rr = { ...rig('od'), optimalDiff: { min: 1000, max: 2_000_000 } };   // priceBtcThDay = 0.0002*24/100
  const r = decide.decide(ctx({ session: s, endpointDiff: 131072, rentals: [], marketRigs: [rr] }));
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.ok(Math.abs(a.rateBtcThDay - 4.8e-5) < 1e-12, 'rateBtcThDay = priceBtcThDay');
  assert.equal(a.endpointDiff, 131072);
  assert.equal(a.optimalDiffMin, 1000);
  assert.equal(a.optimalDiffMax, 2_000_000);
  assert.equal(a.diffInRange, true, 'endpointDiff sits inside [min,max]');
});

test('telemetry fields fall back to null when unknown', () => {
  const s = sess({ target_th: 100 });
  const nullRig = { ...rig('plain'), priceBtcThDay: null, optimalDiff: null };
  // ctx() supplies no endpointDiff.
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [nullRig] }));
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.equal(a.rateBtcThDay, null);
  assert.equal(a.endpointDiff, null);
  assert.equal(a.optimalDiffMin, null);
  assert.equal(a.optimalDiffMax, null);
  assert.equal(a.diffInRange, null);
});

// ---- Null session, zero-minHours, uncapped time/budget (no Infinity blow-up) ----

test('a null session -> not_autopilot, proposes nothing', () => {
  const r = decide.decide(ctx({ session: null, rentals: [], marketRigs: [rig(1)] }));
  assert.equal(r.actions.length, 0);
  assert.ok(r.notes.includes('not_autopilot'));
});

test('a zero-minHours rig is excluded from the feasible set', () => {
  const s = sess({ target_th: 100 });
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [rig('z', { minHours: 0 })] }));
  assert.equal(r.actions.length, 0, 'a zero-length rig cannot be rented');
  assert.ok(r.notes.includes('no_affordable_candidate'));
  assert.ok(r.shortfallTh > 0);
});

test('an uncapped time_cap proposes without an Infinity window error', () => {
  const s = sess({ target_th: 100, time_cap_hours: 0 });
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [rig('a')] }));
  assert.equal(r.actions.length, 1);
  assert.equal(r.windowRemainingH, Infinity);
});

test('a null budget proposes without an Infinity budget error', () => {
  const s = sess({ target_th: 100, budget_sats: null });
  const r = decide.decide(ctx({ session: s, rentals: [], marketRigs: [rig('a')] }));
  assert.equal(r.actions.length, 1);
  assert.equal(r.budgetRemainingSats, Infinity);
});

// ---- contributionTh (direct, per health state) ----

test('contributionTh: advertised while healthy/pending/ramping, measured once degraded/offline', () => {
  const mk = (health) => ({ advertised_th: 100, delivered_th: 40, health });
  for (const h of ['healthy', 'pending', 'ramping']) assert.equal(decide.contributionTh(mk(h)), 100, h);
  for (const h of ['degraded', 'offline']) assert.equal(decide.contributionTh(mk(h)), 40, h);
  // Null-safe fallbacks.
  assert.equal(decide.contributionTh({ health: 'healthy' }), 0);
  assert.equal(decide.contributionTh({ health: 'offline' }), 0);
});
