'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const scoring = require('../engine/scoring');
const quote = require('../quote');

// ---- foldScore (pure) ----

test('foldScore: first rental seeds the mean; subsequent rentals roll it', () => {
  const a = scoring.foldScore(null, { percent: 90, price: 0.001, nowSec: 100 });
  assert.deepEqual(a, { rentals: 1, mean_percent: 90, offline_incidents: 0, last_price: 0.001, last_seen: 100 });
  const b = scoring.foldScore(a, { percent: 100, price: 0.002, nowSec: 200 });
  assert.equal(b.rentals, 2);
  assert.ok(Math.abs(b.mean_percent - 95) < 1e-9, 'running mean (90+100)/2');
  assert.equal(b.last_price, 0.002);
  assert.equal(b.last_seen, 200);
});

test('foldScore: a null/near-zero-delivery rental scores 0 and counts an offline incident', () => {
  const a = scoring.foldScore(null, { percent: null, nowSec: 1 });
  assert.equal(a.mean_percent, 0);
  assert.equal(a.offline_incidents, 1, 'never-delivered -> offline incident');
  const b = scoring.foldScore(a, { percent: 5, nowSec: 2 });     // 5 < OFFLINE_PCT (10)
  assert.equal(b.offline_incidents, 2);
  const c = scoring.foldScore(b, { percent: 50, nowSec: 3 });
  assert.equal(c.offline_incidents, 2, 'a delivering rental adds no incident');
});

test('foldScore: last_price carries forward when a rental omits price', () => {
  const a = scoring.foldScore(null, { percent: 90, price: 0.005, nowSec: 1 });
  const b = scoring.foldScore(a, { percent: 90, price: null, nowSec: 2 });
  assert.equal(b.last_price, 0.005);
});

// ---- persist + load (DB) ----

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-scoring-'));
before(() => db.open(DATA));
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => db.get().prepare('DELETE FROM rig_scores').run());

test('recordRentalScore UPSERTs and accumulates across rentals of the same rig', () => {
  const c = db.get();
  scoring.recordRentalScore(c, { rig_id: 42, rate_btc_th_day: 0.001 }, 80, 100);
  scoring.recordRentalScore(c, { rig_id: 42, rate_btc_th_day: 0.001 }, 100, 200);
  const row = c.prepare('SELECT * FROM rig_scores WHERE rig_id = 42').get();
  assert.equal(row.rentals, 2);
  assert.ok(Math.abs(row.mean_percent - 90) < 1e-9, '(80 + 100) / 2');
  assert.equal(row.last_seen, 200);
});

test('recordRentalScore uses the passed finalPercent and is null-safe on a missing rig_id', () => {
  const c = db.get();
  assert.equal(scoring.recordRentalScore(c, { rate_btc_th_day: 0.001 }, 90, 1), null, 'no rig_id -> no-op');
  scoring.recordRentalScore(c, { rig_id: 7 }, 40, 1);
  assert.ok(Math.abs(c.prepare('SELECT mean_percent FROM rig_scores WHERE rig_id = 7').get().mean_percent - 40) < 1e-9);
});

test('loadRigScores maps mean_percent to a clamped 0..1 factor; unscored rigs are absent', () => {
  const c = db.get();
  c.prepare('INSERT INTO rig_scores (rig_id, rentals, mean_percent) VALUES (1,3,70),(2,1,104),(3,1,NULL)').run();
  const s = scoring.loadRigScores(c);
  assert.ok(Math.abs(s['1'] - 0.7) < 1e-9);
  assert.equal(s['2'], 1, '104% clamps to 1.0');
  assert.equal(s['3'], undefined, 'null mean -> absent (defaults to 1.0 in the rank key)');
});

// ---- the ranking effect ----

test('a 70%-delivery rig ranks BELOW a slightly-pricier 100% rig', () => {
  const rig = (id, hourBtc) => ({
    id: String(id), name: `rig-${id}`, region: 'us', advertisedTh: 100, hourBtc, priceBtcThDay: (hourBtc * 24) / 100,
    measuredTh: { m5: 100, m15: 100, m30: 100 }, minHours: 3, maxHours: 96, minRentalLength: 3, rpi: 95,
    priceEnabled: true, available: true, online: true, poolstatus: 'online', rented: false, status: 'available', optimalDiff: null,
  });
  const flaky = rig('flaky', 0.0001);      // cheaper per TH, but only 70% delivered
  const solid = rig('solid', 0.00012);     // ~20% pricier, but 100%
  const ranked = quote.candidates([flaky, solid], { mode: 'autopilot', minRpi: 90, rigScores: { flaky: 0.7 } });
  assert.deepEqual(ranked.map((r) => r.id), ['solid', 'flaky'], 'the 20% price premium is outweighed by the 43% delivery penalty');
});
