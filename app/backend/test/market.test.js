'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const market = require('../market');
const db = require('../db');
const { createMockServer } = require('../../../scripts/mrr-mock');
const { MrrClient, memoryNonceStore } = require('../mrr-client');

const search = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr/rig-search.json'), 'utf8'));

function approx(a, b, tol = 1e-9) { return Math.abs(a - b) <= tol; }

test('normalizeRig converts sha256ab PH/MH units to TH/s and per-TH pricing', () => {
  const { rigs } = market.normalizeSearchPage(search);
  const byId = Object.fromEntries(rigs.map((r) => [r.id, r]));

  // Rig 800004: advertised 0.23 PH = 230 TH; last_5min 278322449.241 MH = 278.322449241 TH.
  const big = byId['800004'];
  assert.ok(approx(big.advertisedTh, 230), `advertisedTh=${big.advertisedTh}`);
  assert.ok(approx(big.measuredTh.m5, 278.322449241, 1e-6));
  // price.BTC.price 0.00049500 per PH/day -> per TH/day = 0.00049500 / 1000 = 4.95e-7.
  assert.ok(approx(big.priceBtcThDay, 4.95e-7, 1e-12), `priceBtcThDay=${big.priceBtcThDay}`);
  assert.equal(big.hourBtc, 0.00000474375);
  // Hand-check cost_per_th_hour = hourBtc / advertisedTh = 4.74375e-6 / 230 ≈ 2.0625e-8 BTC/TH/hr.
  assert.ok(approx(big.hourBtc / big.advertisedTh, 2.0625e-8, 1e-12));
  assert.equal(big.minHours, 24);
  assert.equal(big.maxHours, 96);
  assert.deepEqual(big.optimalDiff, { min: 535510.48, max: 3213062.882 });
  assert.equal(big.priceEnabled, true);
  assert.equal(big.status, 'rented');
  assert.equal(big.rented, true);

  // Rig 800003: advertised 0.0062 PH = 6.2 TH; BTC pricing DISABLED (only alt coins).
  const small = byId['800003'];
  assert.ok(approx(small.advertisedTh, 6.2, 1e-9), `advertisedTh=${small.advertisedTh}`);
  // price.BTC.price 0.00027505 per PH/day -> per TH/day = 2.7505e-7.
  assert.ok(approx(small.priceBtcThDay, 2.7505e-7, 1e-12));
  assert.equal(small.priceEnabled, false, 'BTC disabled rig is flagged for the eligibility filter');
});

test('a malformed price unit or non-numeric price yields null (never throws or poisons lowest)', () => {
  const mk = (priceType, price) => market.normalizeRig({
    id: '9', hashrate: { advertised: { hash: 0.1, type: 'ph' } },
    price: { type: priceType, BTC: { enabled: true, price } },
    status: { rented: false }, online: true, poolstatus: 'online', available_status: 'available',
  });
  // An unknown/whitespace unit would make perThFactor throw and abort the WHOLE market page.
  assert.equal(mk('ph ', '0.0005').priceBtcThDay, null);
  assert.equal(mk('bogus', '0.0005').priceBtcThDay, null);
  // A non-numeric price must be null, NOT NaN (NaN slips past `!= null` and poisons `lowest`).
  assert.equal(mk('ph', 'not-a-number').priceBtcThDay, null);
  assert.equal(mk('ph', '').priceBtcThDay, null);
  // A well-formed rig still prices normally.
  assert.ok(approx(mk('ph', '0.0005').priceBtcThDay, 5e-7, 1e-12));
});

test('buildMarketSnapshot excludes malformed-price rigs so lowest is finite, never NaN', () => {
  const rig = (id, price) => market.normalizeRig({
    id, hashrate: { advertised: { hash: 0.1, type: 'ph' } },
    price: { type: 'ph', BTC: { enabled: true, price } },
    status: { rented: false }, online: true, poolstatus: 'online', available_status: 'available',
  });
  const snap = market.buildMarketSnapshot([rig('1', '0.0005'), rig('2', 'garbage')], 1000);
  assert.equal(snap.availableRigs, 1, 'the NaN-priced rig is not counted rentable');
  assert.ok(Number.isFinite(snap.lowest) && snap.lowest > 0, `lowest finite, got ${snap.lowest}`);
});

test('normalizeSearchPage coerces the string envelope fields to numbers', () => {
  const page = market.normalizeSearchPage(search);
  assert.equal(page.total, 1622);      // "1622" -> 1622
  assert.equal(page.offset, 0);
  assert.equal(page.count, 2);
  assert.equal(page.rigs.length, 2);
});

test('bool() coerces the stringy flags the API sometimes returns', () => {
  // Exercised through normalizeRig so we hit the real code path.
  const mk = (enabled, rented, online) => market.normalizeRig({
    id: '1', hashrate: { advertised: { hash: 0.1, type: 'ph' } },
    price: { type: 'ph', BTC: { enabled } },
    status: { rented }, online, available_status: 'available',
  });
  assert.equal(mk(true, false, true).priceEnabled, true);
  assert.equal(mk('1', '0', '1').priceEnabled, true);      // "1" -> true
  assert.equal(mk('0', '1', '0').priceEnabled, false);     // "0" -> false (NOT truthy)
  assert.equal(mk('0', '1', '0').rented, true);
  assert.equal(mk('false', 'no', '').online, false);       // "false"/"no"/"" -> false
  assert.equal(mk(1, 0, 1).priceEnabled, true);            // number 1 -> true
  assert.equal(mk(null, undefined, null).priceEnabled, false);
});

test('buildMarketSnapshot counts only BTC-rentable rigs', () => {
  const { rigs } = market.normalizeSearchPage(search);
  const snap = market.buildMarketSnapshot(rigs, 1700000000);
  // Of the two fixture rigs, one has BTC disabled (800003) and one is rented (800004),
  // so neither is rentable right now.
  assert.equal(snap.availableRigs, 0);
  assert.equal(snap.availableTh, 0);
  assert.equal(snap.lowest, null);
  assert.deepEqual(snap.depth, []);
});

test('buildMarketSnapshot ranks a rentable book cheapest-first', () => {
  const rigs = [
    { id: 'a', priceEnabled: true, available: true, rented: false, online: true, poolstatus: 'online', advertisedTh: 100, priceBtcThDay: 5e-7 },
    { id: 'b', priceEnabled: true, available: true, rented: false, online: true, poolstatus: 'online', advertisedTh: 50, priceBtcThDay: 3e-7 },
    { id: 'c', priceEnabled: false, available: true, rented: false, online: true, poolstatus: 'online', advertisedTh: 999, priceBtcThDay: 1e-7 },
  ];
  const snap = market.buildMarketSnapshot(rigs, 1700000000);
  assert.equal(snap.availableRigs, 2);              // 'c' excluded (BTC disabled)
  assert.equal(snap.availableTh, 150);
  assert.equal(snap.lowest, 3e-7);
  assert.equal(snap.depth[0].priceBtcThDay, 3e-7);  // cheapest first
});

test('normalizeRig tolerates a rig with a missing/unknown hash unit', () => {
  const bad = { id: 'x', hashrate: { advertised: { hash: 5 } }, price: { type: 'ph', BTC: {} }, status: {} };
  const n = market.normalizeRig(bad);
  assert.equal(n.advertisedTh, null, 'missing unit -> null, not a thrown error');
  assert.equal(n.priceEnabled, false);
  assert.equal(n.rented, false);
});

test('fetchAllRigs paginates and terminates (no infinite loop on the count field)', async () => {
  const server = createMockServer();
  const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
  try {
    const c = new MrrClient({ key: 'K', secret: 'S', nonceStore: memoryNonceStore(), baseUrl: `http://127.0.0.1:${port}`, throttleMs: 0 });
    const rigs = await market.fetchAllRigs(c, 'sha256ab');
    assert.equal(rigs.length, 2, 'returns exactly the fixture records, then stops');
    assert.ok(rigs.every((r) => r.id));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('fetchAllRigs tolerates a non-numeric total (no under-fetch, no infinite loop)', async () => {
  let page = 0;
  const server = createMockServer({
    scenario: ({ method, path, query }) => {
      if (method === 'GET' && path === '/rig') {
        page += 1;
        const recs = page === 1
          ? [{ id: 'a', hashrate: { advertised: { hash: 0.1, type: 'ph' } }, price: { type: 'ph', BTC: { enabled: true } }, status: {} },
             { id: 'b', hashrate: { advertised: { hash: 0.1, type: 'ph' } }, price: { type: 'ph', BTC: { enabled: true } }, status: {} }]
          : [];
        return { status: 200, json: { success: true, data: { total: 'n/a', offset: Number(query.offset || 0), count: recs.length, records: recs } } };
      }
      return null;
    },
  });
  const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
  try {
    const c = new MrrClient({ key: 'K', secret: 'S', nonceStore: memoryNonceStore(), baseUrl: `http://127.0.0.1:${port}`, throttleMs: 0 });
    const rigs = await market.fetchAllRigs(c, 'sha256ab');
    assert.equal(rigs.length, 2, 'fetched both rigs then stopped at the empty page');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('writeSnapshot persists a row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-mkt-'));
  try {
    db.open(dir);
    const { rigs } = market.normalizeSearchPage(search);
    market.writeSnapshot(db.get(), market.buildMarketSnapshot(rigs, 1700000000));
    const row = db.get().prepare('SELECT * FROM market_snapshots WHERE ts = 1700000000').get();
    assert.ok(row);
    assert.equal(row.available_rigs, 0);
    assert.equal(typeof row.depth_json, 'string');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('depthByRegion aggregates TH + rig count per region, TH-desc', () => {
  const r = market.depthByRegion([
    { th: 100, region: 'us' }, { th: 50, region: 'eu' }, { th: 30, region: 'us' }, { th: 10 },
  ]);
  assert.deepEqual(r, [
    { region: 'us', th: 130, rigs: 2 },
    { region: 'eu', th: 50, rigs: 1 },
    { region: 'unknown', th: 10, rigs: 1 },
  ]);
});

test('cheapNow places the current price in the recent distribution', () => {
  const hist = [{ lowest: 2 }, { lowest: 4 }, { lowest: 6 }, { lowest: 8 }];
  const mid = market.cheapNow(5, hist);
  assert.equal(mid.percentile, 50, 'two of four were cheaper');
  assert.equal(mid.label, 'typical');
  assert.equal(mid.median, 5, 'true median of [2,4,6,8] = (4+6)/2');
  assert.equal(mid.vs_median_pct, 0, 'current 5 == median 5');
  assert.equal(market.cheapNow(1, hist).label, 'cheap', 'below everything -> cheap');
  assert.equal(market.cheapNow(9, hist).label, 'pricey', 'above everything -> pricey');
  assert.equal(market.cheapNow(null, hist).available, false);
  assert.equal(market.cheapNow(5, []).available, false);
});

test('hashValue: blended pay vs market rate (advertised + delivered) with a signed over-market %', () => {
  const latest = { last10: 5e-7, lowest: 4e-7 };
  const rentals = [{ rate_btc_th_day: 5.2e-7, advertised_th: 100, avg_percent: 90 }];
  const hv = market.hashValue(latest, rentals);
  assert.equal(hv.available, true);
  assert.equal(hv.market_sats_ph_day, 50000, '5e-7 BTC/TH·day -> 50k sats/PH·day');
  assert.equal(hv.lowest_sats_ph_day, 40000);
  assert.equal(hv.your_pay_sats_ph_day, 52000, 'TH-weighted advertised pay-rate');
  assert.equal(hv.effective_sats_ph_day, 57778, '52k / 90% delivered');
  assert.equal(hv.over_market_pct, 4, '(52k-50k)/50k = +4%');
  assert.equal(market.hashValue(latest, []).available, false, 'no held rentals -> no pay -> unavailable');
  assert.equal(market.hashValue(null, rentals).available, false, 'no snapshot -> unavailable');
  assert.equal(market.hashValue({ last10: null, lowest: 4e-7 }, rentals).market_sats_ph_day, 40000, 'last10 missing -> lowest is the market ref');
});

test('hashValue: multi-rental TH-weighted blend, null-rate rental excluded, null avg_percent counts as full delivery', () => {
  const latest = { last10: 5e-7, lowest: 4e-7 };
  const rentals = [
    { rate_btc_th_day: 5e-7, advertised_th: 100, avg_percent: 100 },
    { rate_btc_th_day: 6e-7, advertised_th: 50, avg_percent: null },   // null avg -> full delivery
    { rate_btc_th_day: null, advertised_th: 200, avg_percent: 80 },    // null rate -> excluded from blend
  ];
  const hv = market.hashValue(latest, rentals);
  // costRate = 5e-7*100 + 6e-7*50 = 8e-5 BTC/day over adv=150 -> 8e-5/150*1e11 = 53333 sats/PH·day
  assert.equal(hv.your_pay_sats_ph_day, 53333, 'TH-weighted over the two priced rentals only');
  assert.equal(hv.effective_sats_ph_day, 53333, 'both deliver full (100% / null) -> effective == pay');
  assert.equal(hv.over_market_pct, 6.7, '(53333-50000)/50000 = +6.7%');
});

test('hashValue: paying under market yields a negative over_market_pct', () => {
  const latest = { last10: 5e-7, lowest: 4e-7 };
  const rentals = [{ rate_btc_th_day: 4.5e-7, advertised_th: 100, avg_percent: 100 }];
  const hv = market.hashValue(latest, rentals);
  assert.equal(hv.your_pay_sats_ph_day, 45000);
  assert.equal(hv.over_market_pct, -10, 'under market is a negative %');
});
