'use strict';
/*
 * Autopilot never pays far over the market for a single rig.
 *
 * Reported from the field on blake2b: the market's last-10 was ~4,700 sats/TH·day, yet
 * the Autopilot preview for a 9 TH target estimated ~50,000. After the cheap rigs, a
 * ~0.2 TH gap was left, and the only rigs small enough to fill it were never-rented
 * 0.02-0.05 TH listings at 2.9M sats/TH·day. The packer took all five, multiplying the
 * burn tenfold; the live loop shares that packer, so without a blended ceiling it
 * would have rented them.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const quote = require('../quote');
const decide = require('../engine/decide');
const market = require('../market');
const config = require('../config');
const db = require('../db');

// blake2b is priced per TH, so sats/TH·day -> BTC/TH·day is just / 1e8.
const BTC = (satsThDay) => satsThDay / 1e8;

/** A normalized, autopilot-eligible rig of `th` TH at `satsThDay`. */
function rig(id, th, satsThDay) {
  const priceBtcThDay = BTC(satsThDay);
  return {
    id: String(id), name: `rig-${id}`, owner: 'o', region: 'us',
    advertisedTh: th, hourBtc: (priceBtcThDay * th) / 24, priceBtcThDay,
    measuredTh: { m5: th, m15: th, m30: th },
    minHours: 3, maxHours: 96, minRentalLength: 3, rpi: 95,
    priceEnabled: true, available: true, online: true, poolstatus: 'online',
    rented: false, status: 'available', optimalDiff: null,
  };
}

// The shape of the live market that caused the report: normal rigs around 4-6k, and a
// cluster of tiny listings at 600x that are the only thing small enough for a sliver.
const MARKET = [
  rig('a', 2.9, 4800), rig('b', 2.1, 5000), rig('c', 1.3, 5130), rig('d', 1.3, 5130), rig('e', 1.2, 5494),
  rig('big', 40, 3956),
  rig('dust1', 0.018, 2_900_000), rig('dust2', 0.048, 2_900_000), rig('dust3', 0.022, 2_900_000),
  rig('dust4', 0.022, 2_900_000), rig('dust5', 0.03, 2_900_000),
];

const blendSatsThDay = (sel) => {
  const adv = sel.reduce((s, r) => s + r.advertisedTh, 0);
  return (sel.reduce((s, r) => s + r.priceBtcThDay * r.advertisedTh, 0) / adv) * 1e8;
};
const pack = (cands, target) => decide.packToTarget(cands, target,
  { fitTol: 0.2, maxOvershoot: 0.5, budgetRemaining: Infinity, costOf: () => 0 });

test('the reported case: without a limit, dust rigs fill the last sliver at 600x the market', () => {
  const cands = quote.candidates(MARKET, { mode: 'autopilot', minRpi: 90 });
  const { selection } = pack(cands, 9);
  assert.ok(selection.some((r) => r.id.startsWith('dust')), 'reproduces the bug this file guards');
  assert.ok(blendSatsThDay(selection) > 30000);
});

test('with the limit, the same target is filled at market prices', () => {
  const cands = quote.candidates(MARKET, { mode: 'autopilot', minRpi: 90 });
  const limit = quote.marketPriceLimit(cands, { last10BtcThDay: BTC(4703), overMarketPct: 100 });
  const { kept, overpriced } = quote.applyPriceLimit(cands, limit);
  assert.equal(overpriced.length, 5);
  assert.ok(overpriced.every((r) => r.id.startsWith('dust')));

  const { selection, coveredTh } = pack(kept, 9);
  assert.ok(!selection.some((r) => r.id.startsWith('dust')));
  assert.ok(blendSatsThDay(selection) < 6000, `blend ${blendSatsThDay(selection)}`);
  // A small shortfall is the price of not overpaying, and it stays small.
  assert.ok(coveredTh >= 8.5, `covered ${coveredTh}`);
});

test('the reference is the LOWER of last-10 and the median listed price', () => {
  const cands = [rig('1', 1, 4000), rig('2', 1, 5000), rig('3', 1, 6000)];
  const lowLast10 = quote.marketPriceLimit(cands, { last10BtcThDay: BTC(4500), overMarketPct: 100 });
  assert.equal(Math.round(lowLast10.refBtcThDay * 1e8), 4500);
  assert.equal(Math.round(lowLast10.limitBtcThDay * 1e8), 9000);

  // A last-10 lifted by one overpriced rental must not open the gate: the listed median
  // still holds the line.
  const spiked = quote.marketPriceLimit(cands, { last10BtcThDay: BTC(300000), overMarketPct: 100 });
  assert.equal(Math.round(spiked.refBtcThDay * 1e8), 5000);

  // No recent last-10 (fresh install, stale snapshot): the listed median alone.
  const none = quote.marketPriceLimit(cands, { last10BtcThDay: null, overMarketPct: 50 });
  assert.equal(Math.round(none.limitBtcThDay * 1e8), 7500);
});

test('the listed median counts rigs, so a huge listing cannot set it alone', () => {
  // Seen live on sha256: one never-rented listing claiming ~28 EH dominated a
  // hashrate-weighted median. Counted per rig, it is one vote.
  const cands = [rig('1', 1, 4000), rig('2', 1, 5000), rig('3', 1, 6000), rig('whale', 28_000_000, 90000)];
  const limit = quote.marketPriceLimit(cands, { overMarketPct: 0 });
  assert.equal(Math.round(limit.refBtcThDay * 1e8), 5500);
});

test('only overpaying is limited: a rig far below the market is kept', () => {
  const cands = [rig('cheap', 1, 100), rig('2', 1, 5000), rig('3', 1, 5000), rig('dear', 1, 50000)];
  const limit = quote.marketPriceLimit(cands, { last10BtcThDay: BTC(5000), overMarketPct: 100 });
  const { kept, overpriced } = quote.applyPriceLimit(cands, limit);
  assert.deepEqual(kept.map((r) => r.id), ['cheap', '2', '3']);
  assert.deepEqual(overpriced.map((r) => r.id), ['dear']);
});

test('no limit when the setting is off or there is nothing to judge against', () => {
  assert.equal(quote.marketPriceLimit([rig('1', 1, 5000)], { overMarketPct: null }), null);
  assert.equal(quote.marketPriceLimit([], { last10BtcThDay: null, overMarketPct: 100 }), null);
  const all = [rig('1', 1, 5000)];
  assert.equal(quote.applyPriceLimit(all, null).kept, all);
});

test('the live loop applies the limit: it never proposes a dust rig', () => {
  const plan = decide.decide({
    session: { mode: 'autopilot', state: 'active', target_th: 9, budget_sats: 1_000_000, time_cap_hours: 168, spent_sats: 0, started_at: 1000 },
    rentals: [], marketRigs: MARKET, now: 1000, fetchOk: true,
    hashrateTolerancePct: 5, minRpi: 90, priceUnit: 'th',
    fitTolerancePct: 20, maxOvershootPct: 50,
    maxOverMarketPct: 100, last10BtcThDay: BTC(4703),
  });
  assert.ok(plan.actions.length > 0);
  assert.ok(!plan.actions.some((a) => a.rigId.startsWith('dust')), plan.actions.map((a) => a.rigId).join(','));
});

test('the setting defaults to 2x the market', () => {
  assert.equal(config.DEFAULTS.strategy.max_over_market_pct, 100);
});

test('recentLast10 reads the newest snapshot for the ACTIVE algorithm only, and only if recent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-limit-'));
  try {
    db.open(dir);
    const conn = db.get();
    const put = (algo, ts, last10) => conn.prepare('INSERT INTO market_snapshots (algo, ts, last10) VALUES (?, ?, ?)').run(algo, ts, last10);
    put('sha256ab', 10_000, 0.0000005);
    put('blake2b', 10_000, 0.000047);
    put('blake2b', 9_000, 0.000099);

    config.set(conn, 'algorithm', { active: 'blake2b' });
    assert.equal(market.recentLast10(conn, 10_100), 0.000047, 'newest, and never the other market');
    config.set(conn, 'algorithm', { active: 'sha256ab' });
    assert.equal(market.recentLast10(conn, 10_100), 0.0000005);
    assert.equal(market.recentLast10(conn, 10_000 + 3601), null, 'stale is no reference at all');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Is the price limit actually what's holding autopilot back? (price_limit_hold) ----
//
// A real market nearly always has rigs over the limit, so the alert must only blame the
// limit when lifting it would materially help. Each case below is a way the limit can
// sit beside a shortfall without causing it.

const LAST10 = BTC(4703);   // -> limit 9,406 sats/TH·day at the default 100%

function plan(marketRigs, over = {}) {
  const { session: sOver, ...rest } = over;
  return decide.decide({
    session: { mode: 'autopilot', state: 'active', target_th: 30, budget_sats: 1_000_000, time_cap_hours: 168, spent_sats: 0, started_at: 1000, ...sOver },
    rentals: [], marketRigs, now: 1000, fetchOk: true,
    hashrateTolerancePct: 5, minRpi: 90, priceUnit: 'th', fitTolerancePct: 20, maxOvershootPct: 50,
    maxOverMarketPct: 100, last10BtcThDay: LAST10,
    ...rest,
  });
}

const CHEAP = [rig('c1', 2, 5000), rig('c2', 3, 5000)];   // 5 TH under the limit
const DEAR = [rig('d1', 10, 20000), rig('d2', 15, 20000)]; // 25 TH over it

test('hold: the limit is blamed when lifting it would fill the rest', () => {
  const p = plan([...CHEAP, ...DEAR]);
  assert.ok(p.notes.includes('price_limit'), p.notes.join(','));
  assert.equal(Math.round(p.priceLimitHold.heldBackTh), 25);
  assert.equal(p.priceLimitHold.limitSatsUnitDay, 9406);
  assert.equal(p.priceLimitHold.priceUnit, 'th');
  assert.ok(!p.actions.some((a) => a.rigId.startsWith('d')), 'and it still does not rent them');
});

test('not blamed: the over-limit rigs are too big for the gap anyway', () => {
  const p = plan([...CHEAP, rig('huge', 400, 20000)]);
  assert.ok(p.shortfallTh > 20, 'materially short');
  assert.equal(p.priceLimitHold, null);
  assert.ok(!p.notes.includes('price_limit'));
});

test('not blamed: their min rental is longer than the time left', () => {
  const long = DEAR.map((r) => ({ ...r, minHours: 48, minRentalLength: 48 }));
  const p = plan([...CHEAP, ...long], { session: { time_cap_hours: 24 } });
  assert.equal(p.priceLimitHold, null);
});

test('not blamed: the blended ceiling’s backstop would reject them anyway', () => {
  // A 6,000 blended cap puts the per-rig backstop at 12,000, below the dear rigs' 20,000.
  const p = plan([...CHEAP, ...DEAR], { blendedCeilingSatsUnitDay: 6000 });
  assert.equal(p.priceLimitHold, null);
});

test('not blamed: the gate’s per-rig rate ceiling would block the rent anyway', () => {
  // 20,000 sats/TH·day is ~833 sats/TH/hr; a 500 ceiling blocks it after decide proposes it.
  const p = plan([...CHEAP, ...DEAR], { rateCeilingSatsThHour: 500 });
  assert.equal(p.priceLimitHold, null);
});

test('not blamed: the shortfall is a sliver inside the tolerance band (the original dust case)', () => {
  const p = plan(MARKET, { session: { target_th: 9 } });
  assert.ok(!p.actions.some((a) => a.rigId.startsWith('dust')));
  assert.equal(p.priceLimitHold, null);
  assert.ok(!p.notes.includes('price_limit'));
});

test('not blamed: a nearly spent budget whose only affordable rig is overpriced dust', () => {
  // The sane rig's minimum commit is past the remaining budget; a speck of dust is not.
  const p = plan([rig('sane', 40, 4000), rig('speck', 0.005, 2_900_000)],
    { session: { target_th: 9, budget_sats: 3000 } });
  assert.ok(p.notes.includes('no_affordable_candidate'), 'the budget is what binds: ' + p.notes.join(','));
  assert.equal(p.priceLimitHold, null);
});

test('only over-limit rigs left is a market condition, not a spent budget', () => {
  // Every under-limit rig is rented by someone else. The runner closes a session on
  // no_affordable_candidate, so reading this as "out of budget" would end a session that
  // has its whole budget left. It must hold, and say the limit is why.
  const p = plan(DEAR);
  assert.equal(p.actions.length, 0);
  assert.ok(p.notes.includes('no_fit'), p.notes.join(','));
  assert.ok(!p.notes.includes('no_affordable_candidate'));
  assert.ok(p.priceLimitHold, 'and the hold is attributed to the limit');
});
