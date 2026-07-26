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

// ---- backfill (self-healing sweep for missed end-edges) ----

test('backfillScores folds an ended-but-unscored rental once, marks it scored, and is idempotent', () => {
  const c = db.get();
  c.prepare('INSERT INTO rentals (mrr_id, rig_id, advertised_th, avg_percent, ended, end_ts, scored) VALUES (9101, 555, 205, 0, 1, 1000, 0)').run();
  assert.equal(scoring.backfillScores(c, 2000), 1, 'one unscored ended rental folded');
  const row = c.prepare('SELECT * FROM rig_scores WHERE rig_id = 555').get();
  assert.equal(row.rentals, 1);
  assert.equal(row.mean_percent, 0, '0% delivery recorded');
  assert.equal(c.prepare('SELECT scored FROM rentals WHERE mrr_id = 9101').get().scored, 1, 'rental marked scored');
  assert.equal(scoring.backfillScores(c, 3000), 0, 'second sweep folds nothing');
  assert.equal(c.prepare('SELECT rentals FROM rig_scores WHERE rig_id = 555').get().rentals, 1, 'not double-counted');
  c.prepare('DELETE FROM rentals WHERE mrr_id = 9101').run();
});

test('backfillScores skips still-active rentals and only folds ended ones', () => {
  const c = db.get();
  c.prepare('INSERT INTO rentals (mrr_id, rig_id, advertised_th, avg_percent, ended, end_ts, scored) VALUES (9110, 601, 100, 98, 1, 1000, 0), (9111, 602, 100, 50, 0, NULL, 0)').run();
  assert.equal(scoring.backfillScores(c, 2000), 1, 'only the ended rental (601) folds; the active one (602) is left alone');
  assert.ok(c.prepare('SELECT 1 FROM rig_scores WHERE rig_id = 601').get(), 'ended rig scored');
  assert.equal(c.prepare('SELECT 1 FROM rig_scores WHERE rig_id = 602').get(), undefined, 'active rig not scored yet');
  c.prepare('DELETE FROM rentals WHERE mrr_id IN (9110, 9111)').run();
});

test('a backfilled 0%-delivery rig loads as expectedDelivery 0 and sorts last (never re-rented)', () => {
  const c = db.get();
  c.prepare('INSERT INTO rentals (mrr_id, rig_id, advertised_th, avg_percent, ended, end_ts, scored) VALUES (9102, 556, 205, 0, 1, 1000, 0)').run();
  scoring.backfillScores(c, 2000);
  assert.equal(scoring.loadRigScores(c)['556'], 0, 'dead rig -> 0 delivery factor');
  const mk = (id, hourBtc) => ({
    id: String(id), name: `rig-${id}`, region: 'eu', advertisedTh: 205, hourBtc, priceBtcThDay: (hourBtc * 24) / 205,
    measuredTh: { m5: 205, m15: 205, m30: 205 }, minHours: 3, maxHours: 96, minRentalLength: 3, rpi: 95,
    priceEnabled: true, available: true, online: true, poolstatus: 'online', rented: false, status: 'available', optimalDiff: null,
  });
  const ranked = quote.candidates([mk(557, 0.0002), mk(556, 0.0001)], { mode: 'autopilot', minRpi: 90, rigScores: scoring.loadRigScores(c) });
  assert.equal(ranked[ranked.length - 1].id, '556', 'the 0%-delivery rig ranks last (rankKey Infinity) despite being cheapest');
  assert.equal(ranked[ranked.length - 1].rankKey, Infinity);
  c.prepare('DELETE FROM rentals WHERE mrr_id = 9102').run();
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
