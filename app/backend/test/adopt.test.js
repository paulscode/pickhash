'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const adopt = require('../engine/adopt');
const alerts = require('../alerts');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-adopt-'));
const endpoint = { host: 'ab.gg', port: 26596, worker_base: 'bc1qx.phash' };
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

let sessionId;
beforeEach(() => {
  const c = db.get();
  for (const t of ['rentals', 'sessions', 'alerts', 'spend_events']) c.prepare(`DELETE FROM ${t}`).run();
  sessionId = Number(c.prepare("INSERT INTO sessions (mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at) VALUES ('autopilot','active',300,1000000,0,0,1,1)").run().lastInsertRowid);
});

function detail(mrrId, over = {}) {
  return {
    id: String(mrrId), rig: { name: 'Orphan', region: 'us' }, length: 3, start: 1000, end: 1000 + 3 * 3600,
    price: { paid: 0.0006, currency: 'BTC' }, hashrate: { advertised: { hash: '0.1', type: 'ph' } }, ...over,
  };
}
function mockClient(handlers = {}) {
  const state = { puts: [], gets: [] };
  return {
    state,
    async get(p) { state.gets.push(p); if (handlers[p]) return handlers[p](); throw new Error('no detail ' + p); },
    async put(p, params) { state.puts.push([p, params]); return { message: 'ok' }; },
  };
}

test('adoptStrays inserts a tracked rental from MRR detail, counts the spend, re-points, and alerts', async () => {
  const client = mockClient({ '/rental/9001': () => detail(9001) });
  const r = await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9001', rigId: 42 }], nowSec: 5000 });
  assert.deepEqual(r.adopted, [9001]);
  const row = db.get().prepare('SELECT * FROM rentals WHERE mrr_id = 9001').get();
  assert.ok(row, 'rental row inserted');
  assert.equal(row.session_id, sessionId);
  assert.ok(Math.abs(row.advertised_th - 100) < 1e-9, '0.1 PH -> 100 TH');
  assert.equal(row.paid_sats + row.fee_sats, 60_000, '0.0006 BTC total counted');
  assert.equal(row.health, 'pending');
  assert.equal(row.worker_name, 'bc1qx.phash-r9001');
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId).spent_sats, 60_000, 'orphan counts against the budget');
  assert.equal(db.get().prepare('SELECT sats FROM spend_events WHERE mrr_id = 9001').get().sats, 60_000);
  assert.equal(client.state.puts.filter((p) => /\/pool\/0$/.test(p[0])).length, 1, 'pool override re-applied');
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'rental_adopted'").get());
});

test('adoptStrays never re-adopts a rental already tracked', async () => {
  db.get().prepare("INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (?,9002,1,'r',100,3,1000,30,1,999,0,'healthy','w')").run(sessionId);
  const client = mockClient({ '/rental/9002': () => detail(9002) });
  const r = await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9002', rigId: 1 }], nowSec: 5000 });
  assert.equal(r.adopted.length, 0);
  assert.equal(client.state.gets.length, 0, 'no detail fetch for an already-tracked rental');
});

test('adoptStrays reports (does not drop or mis-bill) a stray whose detail is unavailable or has no billed amount', async () => {
  const noFetch = mockClient({});   // get throws
  const r1 = await adopt.adoptStrays(db.get(), noFetch, { sessionId, endpoint, adopt: [{ mrrId: '9003', rigId: 1 }], nowSec: 5000 });
  assert.deepEqual(r1.failed.map((s) => s.mrrId), ['9003']);
  assert.equal(r1.adopted.length, 0);
  const noPaid = mockClient({ '/rental/9004': () => detail(9004, { price: {} }) });
  const r2 = await adopt.adoptStrays(db.get(), noPaid, { sessionId, endpoint, adopt: [{ mrrId: '9004', rigId: 1 }], nowSec: 5000 });
  assert.deepEqual(r2.failed.map((s) => s.mrrId), ['9004']);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals WHERE mrr_id = 9004').get().n, 0, 'no row inserted without a known billed amount');
});

test('adoptStrays: a failed pool-override PUT still adopts the rental (row + spend recorded)', async () => {
  const client = {
    state: { puts: [], gets: [] },
    async get(p) { this.state.gets.push(p); return detail(9101); },
    async put(p, params) { this.state.puts.push([p, params]); throw new Error('MRR 500 on pool override'); },
  };
  const r = await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9101', rigId: 7 }], nowSec: 5000 });
  assert.deepEqual(r.adopted, [9101], 'adopted despite the override failing (health flags under-delivery instead)');
  assert.ok(db.get().prepare('SELECT 1 FROM rentals WHERE mrr_id = 9101').get(), 'tracked row inserted');
  assert.equal(db.get().prepare('SELECT sats FROM spend_events WHERE mrr_id = 9101').get().sats, 60_000, 'spend recorded');
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId).spent_sats, 60_000);
});

test('adoptStrays: non-positive start/end fall back to nowSec and a computed end', async () => {
  const client = mockClient({ '/rental/9102': () => detail(9102, { start: 0, end: 0, length: 3 }) });
  await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9102', rigId: 1 }], nowSec: 5000 });
  const row = db.get().prepare('SELECT start_ts, end_ts FROM rentals WHERE mrr_id = 9102').get();
  assert.equal(row.start_ts, 5000, 'start (<= 0) falls back to nowSec');
  assert.equal(row.end_ts, 5000 + 3 * 3600, 'end (<= 0) is start + round(lengthHours * 3600)');
});

test('adoptStrays: a mixed batch adopts the good strays, reports the incomplete one, and sums the spend', async () => {
  const client = mockClient({
    '/rental/9201': () => detail(9201),
    '/rental/9202': () => detail(9202, { price: {} }),   // incomplete -> no billed amount -> failed
    '/rental/9203': () => detail(9203),
  });
  const r = await adopt.adoptStrays(db.get(), client, {
    sessionId, endpoint, nowSec: 5000,
    adopt: [{ mrrId: '9201', rigId: 1 }, { mrrId: '9202', rigId: 2 }, { mrrId: '9203', rigId: 3 }],
  });
  assert.deepEqual(r.adopted, [9201, 9203], 'both good strays adopted');
  assert.deepEqual(r.failed.map((s) => s.mrrId), ['9202'], 'the incomplete stray is reported');
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId).spent_sats, 120_000, 'session spend is the cumulative total of both adopted');
});

test('adoptStrays: the base/fee split is exact (60,000 total -> 58,252 base + 1,748 fee)', async () => {
  const client = mockClient({ '/rental/9301': () => detail(9301) });
  await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9301', rigId: 1 }], nowSec: 5000 });
  const row = db.get().prepare('SELECT paid_sats, fee_sats FROM rentals WHERE mrr_id = 9301').get();
  assert.equal(row.paid_sats, 58_252);
  assert.equal(row.fee_sats, 1_748);
});

test('adoptStrays: missing advertised hashrate yields a null advertised_th without throwing', async () => {
  const client = mockClient({ '/rental/9401': () => detail(9401, { hashrate: {} }) });
  const r = await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9401', rigId: 1 }], nowSec: 5000 });
  assert.deepEqual(r.adopted, [9401]);
  const row = db.get().prepare('SELECT advertised_th, rate_btc_th_day FROM rentals WHERE mrr_id = 9401').get();
  assert.equal(row.advertised_th, null);
  assert.equal(row.rate_btc_th_day, null, 'no advertised TH -> no derivable rate (excluded from the blend, not guessed)');
});

test('adoptStrays back-computes rate_btc_th_day so an adopted rig joins the hash-value blend', async () => {
  const client = mockClient({ '/rental/9501': () => detail(9501) });
  await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9501', rigId: 7 }], nowSec: 5000 });
  const row = db.get().prepare('SELECT rate_btc_th_day, paid_sats, advertised_th, length_hours FROM rentals WHERE mrr_id = 9501').get();
  assert.ok(row.rate_btc_th_day > 0, 'a per-TH·day rate was stored');
  // The rate must back out the fee-exclusive base: rate × adv × (hours/24) × 1e8 ≈ base_sats (== paid_sats here).
  const reconstructed = row.rate_btc_th_day * row.advertised_th * (row.length_hours / 24) * 1e8;
  assert.ok(Math.abs(reconstructed - row.paid_sats) < 1, 'rate reconstructs the base cost');
});

test('adoptStrays lifts the reconcile halt for the orphan it adopts (both key shapes); an unrelated halt survives', async () => {
  const c = db.get();
  // The ambiguous create raised its halt as `sess{id}rig{rigId}` (execute) or, from a prior
  // failed-adopt tick, as `mrr{id}` (runner). Adopting the orphan must clear BOTH — otherwise the
  // halt stays up forever and autopilot never resumes. A genuinely-unrelated stray keeps its halt.
  alerts.fireOnce(c, { kind: 'needs_reconcile', now: 1000, key: `sess${sessionId}rig42` });
  alerts.fireOnce(c, { kind: 'needs_reconcile', now: 1000, key: 'mrr9001' });
  alerts.fireOnce(c, { kind: 'needs_reconcile', now: 1000, key: 'mrr9999' });   // unrelated
  const client = mockClient({ '/rental/9001': () => detail(9001) });
  const r = await adopt.adoptStrays(c, client, { sessionId, endpoint, adopt: [{ mrrId: '9001', rigId: 42 }], nowSec: 5000 });
  assert.deepEqual(r.adopted, [9001]);
  const state = (key) => c.prepare("SELECT state FROM alerts WHERE kind='needs_reconcile' AND key = ?").get(key).state;
  assert.equal(state(`sess${sessionId}rig42`), 'resolved', 'ambiguous-create halt cleared by adoption');
  assert.equal(state('mrr9001'), 'resolved', 'prior failed-adopt halt cleared');
  assert.equal(state('mrr9999'), 'fired', 'an unrelated stray keeps its halt');
});

test('adoptStrays: once its orphan is adopted, the reconcile halt lifts so spend resumes unattended', async () => {
  const c = db.get();
  alerts.fireOnce(c, { kind: 'needs_reconcile', now: 1000, key: `sess${sessionId}rig42` });
  assert.equal(alerts.reconcileHalted(c), true, 'halted while the ambiguous orphan is outstanding');
  const client = mockClient({ '/rental/9001': () => detail(9001) });
  await adopt.adoptStrays(c, client, { sessionId, endpoint, adopt: [{ mrrId: '9001', rigId: 42 }], nowSec: 5000 });
  assert.equal(alerts.reconcileHalted(c), false, 'the sole halt lifted once its orphan was adopted');
});

test('adoptStrays in DRY-RUN records the billed money but does NOT re-point the rental (no live PUT)', async () => {
  const client = mockClient({ '/rental/9601': () => detail(9601) });
  await adopt.adoptStrays(db.get(), client, { sessionId, endpoint, adopt: [{ mrrId: '9601', rigId: 7 }], nowSec: 5000, dryRun: true });
  assert.ok(db.get().prepare('SELECT 1 FROM rentals WHERE mrr_id = 9601').get(), 'the orphan is still tracked + billed in DRY-RUN');
  assert.equal(client.state.puts.filter((p) => /\/pool\/0$/.test(p[0])).length, 0, 'no pool re-point PUT fired in DRY-RUN');
});
