'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const quote = require('../quote');
const market = require('../market');

const search = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr/rig-search.json'), 'utf8'));

// A synthetic eligible rig; override fields per test.
function rig(over = {}) {
  return {
    id: 'r1', name: 'R', region: 'us-east', rpi: 95,
    advertisedTh: 100, measuredTh: { m5: 100, m15: 100, m30: 100 },
    hourBtc: 0.000005, minHours: 3, maxHours: 96, minRentalLength: 3,
    optimalDiff: { min: 1000, max: 1000000 },
    extensions: true, online: true, poolstatus: 'online', status: 'available',
    rented: false, available: true, priceEnabled: true, ...over,
  };
}
const approx = (a, b, tol = 1e-15) => Math.abs(a - b) <= tol;

test('derive computes the ranking inputs', () => {
  const d = quote.derive(rig());
  assert.ok(approx(d.costPerThHour, 5e-8), `costPerThHour=${d.costPerThHour}`);   // 0.000005 / 100
  assert.equal(d.measuredAvgTh, 100);
  assert.equal(d.stabilityPct, 0);
  assert.equal(d.minCommitSats, 1545);                                            // 0.000005*3*1e8*1.03
  assert.equal(d.expectedDelivery, 1.0);
  assert.ok(approx(d.rankKey, 5e-8));
});

test('rank key divides cost by expected delivery (a worse-delivering rig ranks worse)', () => {
  const d = quote.derive(rig(), { rigScores: { r1: 0.5 } });
  assert.ok(approx(d.rankKey, 1e-7), `rankKey=${d.rankKey}`);   // 5e-8 / 0.5
});

test('stability is the worst window deviation from advertised', () => {
  const d = quote.derive(rig({ measuredTh: { m5: 100, m15: 70, m30: 100 } }));
  assert.equal(d.stabilityPct, 30);   // max(|70-100|)/100 * 100
});

test('eligibility filters the real fixture rigs for the documented reasons', () => {
  const rigs = market.normalizeSearchPage(search).rigs.map((r) => quote.derive(r));
  const byId = Object.fromEntries(rigs.map((r) => [r.id, r]));
  assert.deepEqual(quote.eligibility(byId['800003']).reasons, ['btc_disabled']);   // BTC pricing disabled
  const rented = quote.eligibility(byId['800004']).reasons;
  assert.ok(rented.includes('rented') && rented.includes('not_available'));
});

test('each hard filter rejects for a targeted reason', () => {
  const cases = {
    low_rpi: rig({ rpi: 50 }),
    blacklisted: rig(),
    offline: rig({ online: false }),
    pool_offline: rig({ poolstatus: 'offline' }),
    btc_disabled: rig({ priceEnabled: false }),
    no_hashrate: rig({ advertisedTh: 0 }),
    diff_mismatch: rig({ optimalDiff: { min: 5_000_000, max: 9_000_000 } }),
  };
  assert.ok(quote.eligibility(quote.derive(cases.low_rpi)).reasons.includes('low_rpi'));
  assert.ok(quote.eligibility(quote.derive(cases.blacklisted), { blacklist: ['r1'] }).reasons.includes('blacklisted'));
  assert.ok(quote.eligibility(quote.derive(cases.offline)).reasons.includes('offline'));
  assert.ok(quote.eligibility(quote.derive(cases.pool_offline)).reasons.includes('pool_offline'));
  assert.ok(quote.eligibility(quote.derive(cases.btc_disabled)).reasons.includes('btc_disabled'));
  assert.ok(quote.eligibility(quote.derive(cases.no_hashrate)).reasons.includes('no_hashrate'));
  // optimal_diff is ADVISORY by default: a rig outside the range is still eligible (rentals
  // deliver outside it live), and only excluded when the operator opts into strict mode.
  const outOfRange = quote.derive(cases.diff_mismatch, { endpointDiff: 131072 });
  assert.equal(outOfRange.diffInRange, false, 'flagged as outside the optimal range');
  assert.equal(quote.eligibility(outOfRange, { endpointDiff: 131072 }).ok, true, 'not excluded by default');
  assert.ok(quote.eligibility(outOfRange, { endpointDiff: 131072, strictDiff: true }).reasons.includes('diff_mismatch'), 'excluded only in strict mode');
  // In-range rig is flagged true; unknown difficulty -> null.
  assert.equal(quote.derive(rig({ optimalDiff: { min: 1000, max: 1000000 } }), { endpointDiff: 131072 }).diffInRange, true);
  assert.equal(quote.derive(rig()).diffInRange, null);
});

test('stability handling differs by mode: quick allows, autopilot rejects', () => {
  const unstable = quote.derive(rig({ measuredTh: { m5: 40, m15: 100, m30: 100 } }));   // 60% swing
  assert.equal(quote.eligibility(unstable, { mode: 'quick' }).ok, true);
  assert.ok(quote.eligibility(unstable, { mode: 'autopilot' }).reasons.includes('unstable'));
  // No measurement history: autopilot rejects, quick allows.
  const noHistory = quote.derive(rig({ measuredTh: {} }));
  assert.ok(quote.eligibility(noHistory, { mode: 'autopilot' }).reasons.includes('no_stability_data'));
  assert.equal(quote.eligibility(noHistory, { mode: 'quick' }).ok, true);
});

test('candidates returns eligible rigs sorted by rank key (ties broken by id)', () => {
  const rigs = [
    rig({ id: 'expensive', hourBtc: 0.00001 }),   // costPerThHour 1e-7
    rig({ id: 'cheap', hourBtc: 0.000004 }),       // 4e-8
    rig({ id: 'rented-out', rented: true }),
    rig({ id: 'tieB', hourBtc: 0.000006 }),        // 6e-8
    rig({ id: 'tieA', hourBtc: 0.000006 }),        // 6e-8 (tie -> id order)
  ];
  const c = quote.candidates(rigs);
  assert.deepEqual(c.map((r) => r.id), ['cheap', 'tieA', 'tieB', 'expensive']);   // rented filtered out
});

// ---- Packer ----

// A pool of eligible, ranked candidates (as candidates() would return them).
function pool() {
  return quote.candidates([
    rig({ id: 'a', hourBtc: 0.000004, advertisedTh: 50, minHours: 3, maxHours: 96 }),
    rig({ id: 'b', hourBtc: 0.000005, advertisedTh: 50, minHours: 3, maxHours: 96 }),
    rig({ id: 'c', hourBtc: 0.000006, advertisedTh: 50, minHours: 3, maxHours: 96 }),
    rig({ id: 'd', hourBtc: 0.000007, advertisedTh: 50, minHours: 3, maxHours: 96 }),
  ]);
}

test('packBudget (target+duration -> cost) reproduces MRR per-rental fee math', () => {
  // One rig, 8 h at 0.000005 BTC/h -> base = round(0.000005*8*1e8) = 4000 sats, fee = round(120) = 120.
  const r = quote.packBudget([quote.derive(rig({ id: 'x', hourBtc: 0.000005, advertisedTh: 50 }))], 40, 8);
  assert.equal(r.rigs.length, 1);
  assert.equal(r.baseSats, 4000);
  assert.equal(r.feeSats, 120);
  assert.equal(r.totalSats, 4120);
  assert.equal(r.durationHours, 8);
  assert.equal(r.shortfallTh, 0);
});

test('packBudget flags a shortfall when the book cannot meet the target', () => {
  const r = quote.packBudget(pool(), 500, 24);   // pool only has 200 TH total
  assert.equal(r.targetTh, 200);
  assert.equal(r.shortfallTh, 300);
  assert.ok(r.warnings.includes('shortfall'));
});

test('packDuration (budget+target -> duration) picks the cheapest rigs and a fitting length', () => {
  // Want 100 TH -> cheapest two rigs a+b (burn 0.000009 BTC/h = 900 sats/h). Budget 50000 sats.
  const r = quote.pack(pool(), { compute: 'duration', budgetSats: 50000, targetTh: 100 });
  assert.deepEqual(r.rigs.map((x) => x.id), ['a', 'b']);
  assert.ok(r.durationHours > 0);
  assert.ok(r.totalSats <= 50000, `total ${r.totalSats} <= 50000`);
  // Duration ~ (50000/1.03) / 900 ~= 53.9 h, clamped by nothing here.
  assert.ok(r.durationHours > 50 && r.durationHours < 55, `D=${r.durationHours}`);
});

test('packDuration clamps the duration to the shortest max-hours in the pack', () => {
  const cands = quote.candidates([
    rig({ id: 'a', hourBtc: 0.000004, advertisedTh: 50, minHours: 1, maxHours: 6 }),
    rig({ id: 'b', hourBtc: 0.000005, advertisedTh: 50, minHours: 1, maxHours: 96 }),
  ]);
  const r = quote.packDuration(cands, 500000, 100);   // huge budget would buy a long run
  assert.equal(r.durationHours, 6, 'clamped to rig a max of 6 h');
  assert.ok(r.warnings.includes('maxhours_capped'), 'user is told the budget was under-spent due to the rig cap');
});

test('packDuration drops a rig whose min-hours exceeds the affordable duration, then re-packs', () => {
  // Cheapest rig demands a 48 h minimum, but the budget only affords a few hours.
  const cands = quote.candidates([
    rig({ id: 'longonly', hourBtc: 0.000004, advertisedTh: 50, minHours: 48, maxHours: 96 }),
    rig({ id: 'flex', hourBtc: 0.000006, advertisedTh: 50, minHours: 1, maxHours: 96 }),
  ]);
  const r = quote.packDuration(cands, 4000, 50);   // ~6.5 h affordable -> longonly can't run that short
  assert.deepEqual(r.rigs.map((x) => x.id), ['flex']);
  assert.ok(r.durationHours >= 1);
  assert.ok(r.totalSats <= 4000);
});

test('packTarget (budget+duration -> hashrate) packs as much as the hourly budget affords', () => {
  // Budget 100000 sats over 24 h -> base/h affordable = (100000/1.03)/24 ~= 4046 sats/h.
  // Rigs cost 400..700 sats/h; all four fit (2200 sats/h) -> full 200 TH.
  const r = quote.pack(pool(), { compute: 'target', budgetSats: 100000, durationHours: 24 });
  assert.equal(r.targetTh, 200);
  assert.ok(r.totalSats <= 100000);
});

test('packTarget flags market_capped when the whole eligible book is bought and budget remains', () => {
  // Huge budget over 24 h: all four rigs fit -> 200 TH is the market ceiling, not the spend.
  const r = quote.pack(pool(), { compute: 'target', budgetSats: 1e8, durationHours: 24 });
  assert.equal(r.targetTh, 200);
  assert.equal(r.rigs.length, 4);
  assert.ok(r.warnings.includes('market_capped'), 'more spend cannot add hashrate — the book is exhausted');
});

test('packTarget does NOT flag market_capped when the budget (not supply) is the limit', () => {
  // Budget only affords the two cheapest rigs -> supply is not the binding constraint.
  const r = quote.pack(pool(), { compute: 'target', budgetSats: 25000, durationHours: 24 });
  assert.ok(r.rigs.length < 4);
  assert.ok(!r.warnings.includes('market_capped'));
});

test('packTarget stops adding rigs once the hourly budget is spent', () => {
  // Tight budget: only the cheapest rig fits.
  const r = quote.pack(pool(), { compute: 'target', budgetSats: 300, durationHours: 24 });
  // (300/1.03)/24 ~= 12.1 sats/h — cheapest rig is 400 sats/h, so nothing fits.
  assert.equal(r.targetTh, 0);
  assert.equal(r.totalSats, 0);
  assert.ok(r.warnings.includes('budget_too_low'), 'a zero-hashrate result carries a reason');
});

test('packTarget flags an infeasible duration (outside every rig min/max) with a reason', () => {
  // All pool rigs are min 3h / max 96h; ask for 200h.
  const r = quote.pack(pool(), { compute: 'target', budgetSats: 1e9, durationHours: 200 });
  assert.equal(r.targetTh, 0);
  assert.ok(r.warnings.includes('infeasible_duration'));
});

test('property: packDuration never exceeds the stated budget', () => {
  // Deterministic pseudo-random sweep (no Math.random — a fixed LCG).
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(rand() * 6);
    const rigs = [];
    for (let j = 0; j < n; j++) {
      rigs.push(rig({
        id: `r${j}`,
        hourBtc: 0.000001 + rand() * 0.00001,
        advertisedTh: 10 + Math.floor(rand() * 100),
        minHours: 1 + Math.floor(rand() * 24),
        maxHours: 24 + Math.floor(rand() * 200),
      }));
    }
    const cands = quote.candidates(rigs);
    const budgetSats = 1000 + Math.floor(rand() * 2_000_000);
    const targetTh = 10 + Math.floor(rand() * 400);
    const r = quote.packDuration(cands, budgetSats, targetTh);
    assert.ok(r.totalSats <= budgetSats, `budget ${budgetSats} exceeded by total ${r.totalSats} (iter ${i})`);
    // Every packed rig can actually run for the chosen duration.
    for (const x of r.rigs) {
      assert.ok(r.durationHours >= (x.minHours || 0) - 1e-6, `duration ${r.durationHours} < min ${x.minHours}`);
      assert.ok(r.durationHours <= (x.maxHours || Infinity) + 1e-6, `duration ${r.durationHours} > max ${x.maxHours}`);
    }
  }
});
