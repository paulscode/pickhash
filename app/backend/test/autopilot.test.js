'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const autopilot = require('../engine/autopilot');
const alerts = require('../alerts');
const config = require('../config');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-auto-'));

// A raw MRR /rig record (market.normalizeRig input) that passes autopilot eligibility:
// available/online/pool-online, BTC enabled, rpi 95, perfectly stable (measured==advertised).
function rawRig(id, phAdvertised = 0.1, hourBtc = 0.0002) {
  const mh = String(phAdvertised * 1e9);   // PH -> MH for the measured windows
  return {
    id: String(id), name: `rig-${id}`, owner: `o${id}`, type: 'sha256ab',
    status: { status: 'available', rented: false, online: true }, online: true,
    poolstatus: 'online', region: 'us-east', rpi: '95.00',
    optimal_diff: { min: '1000', max: '2000000' }, extensions: true,
    price: { type: 'ph', BTC: { currency: 'BTC', price: '0.00050000', hour: String(hourBtc), min_rental_length: 3, enabled: true } },
    minhours: '3', maxhours: '96',
    hashrate: {
      advertised: { hash: String(phAdvertised), type: 'ph' },
      last_5min: { hash: mh, type: 'mh' }, last_15min: { hash: mh, type: 'mh' }, last_30min: { hash: mh, type: 'mh' },
    },
    available_status: 'available',
  };
}

function mockClient() {
  const state = { gets: [], puts: [], nextId: 8_000_000 };
  const rigs = [rawRig(901), rawRig(902), rawRig(903)];
  return {
    state,
    async get(p, params) {
      state.gets.push([p, params]);
      if (p === '/rig') return (params && params.offset > 0) ? { records: [], total: 3 } : { records: rigs, total: 3, offset: 0, count: 3 };
      throw new Error('unexpected get ' + p);
    },
    async put(p, params) {
      state.puts.push([p, params]);
      if (p === '/rental') return { id: String(state.nextId++), start_unix: 1_000_000, end_unix: 1_000_000 + 3 * 3600 };
      if (/^\/rental\/\d+\/pool\/0$/.test(p)) return { message: 'ok' };
      throw new Error('unexpected put ' + p);
    },
  };
}

let sessionId;
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  for (const t of ['rentals', 'decisions', 'sessions', 'alerts', 'pool_endpoints']) c.prepare(`DELETE FROM ${t}`).run();
  c.prepare('DELETE FROM config').run();
  c.prepare('INSERT INTO pool_endpoints (host, port, worker_base, stratum_diff, mrr_pool_id, mrr_profile_id, active) VALUES (?,?,?,?,?,?,1)')
    .run('ab.gg', 26596, 'bc1qx.phash', 131072, 111, 953073);
  // Started 1h ago on the test clock, so the 168h time cap is still open.
  sessionId = Number(c.prepare(
    'INSERT INTO sessions (mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('autopilot', 'active', 300, 1_000_000, 168, 0, 0, NOW_SEC - 3600, NOW_SEC - 3600).lastInsertRowid);
});

function snap(rentals) {
  return { session: db.get().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId), rentals, fetch_ok: { rentals: true } };
}
const NOW_SEC = 1_000_000;
const now = NOW_SEC * 1000;   // fixed ms clock for the cycle

test('at target: no market fetch, no rents (cheap pre-check short-circuits)', async () => {
  const client = mockClient();
  const r = await autopilot.runCycle(db.get(), client, snap([{ rig_id: 900, advertised_th: 300, delivered_th: 300, health: 'healthy', ended: 0 }]), { now });
  assert.equal(r.ran, false);
  assert.equal(client.state.gets.length, 0, 'no /rig fetch when already at target');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
});

test('below target in DRY-RUN: fetches the market, records would-do, mutates nothing', async () => {
  const client = mockClient();   // run mode defaults to dry-run
  const r = await autopilot.runCycle(db.get(), client, snap([{ rig_id: 900, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 0 }]), { now });
  assert.equal(r.ran, true);
  assert.ok(client.state.gets.some((g) => g[0] === '/rig'), 'market fetched for the gap');
  assert.equal(client.state.puts.length, 0, 'no mutations in DRY-RUN');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
  assert.ok(db.get().prepare("SELECT COUNT(*) n FROM decisions WHERE note LIKE 'AUTOPILOT DRY-RUN%'").get().n >= 1);
});

test('below target in LIVE: rents ONE rig this tick (paced) and advances spent', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = mockClient();
  const r = await autopilot.runCycle(db.get(), client, snap([{ rig_id: 900, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 0 }]), { now });
  assert.equal(r.ran, true);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 1, 'one rent per tick (pacing)');
  const s = db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId);
  assert.ok(s.spent_sats > 0, 'spent advanced so the gate sees it next tick');
  assert.equal(client.state.puts.filter((p) => /\/pool\/0$/.test(p[0])).length, 1, 'worker override applied');
});

test('a fired endpoint_down halts autopilot rents even in LIVE', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  alerts.runTransition(db.get(), { kind: 'endpoint_down', bad: true, now: Date.now(), thresholdMs: 0 });
  const client = mockClient();
  const r = await autopilot.runCycle(db.get(), client, snap([{ rig_id: 900, advertised_th: 100, delivered_th: 100, health: 'healthy', ended: 0 }]), { now });
  assert.equal(r.gateResult.authorized.length, 0);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'no rent while the endpoint is down');
});

test('a session closed THIS tick (stale snapshot) is not topped up — re-reads state fresh', async () => {
  // Lifecycle closed the session earlier in the same tick; the snapshot still says 'active'.
  db.get().prepare('UPDATE sessions SET state = ? WHERE id = ?').run('ended', sessionId);
  const client = mockClient();
  const staleSnap = { session: { id: sessionId, mode: 'autopilot', state: 'active', target_th: 300, budget_sats: 1_000_000, spent_sats: 0, started_at: NOW_SEC - 3600, time_cap_hours: 168 }, rentals: [], fetch_ok: { rentals: true } };
  const r = await autopilot.runCycle(db.get(), client, staleSnap, { now });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'not_autopilot');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'no rental created on a dead session');
});

test('autopilot is paused while a needs_reconcile orphan is outstanding (no double-spend)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  alerts.fireOnce(db.get(), { kind: 'needs_reconcile', key: 'mrr9999', now: Date.now() });
  const r = await autopilot.runCycle(db.get(), mockClient(), snap([]), { now });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'needs_reconcile');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
});

test('a quick session is never touched by autopilot', async () => {
  db.get().prepare("UPDATE sessions SET mode = 'quick' WHERE id = ?").run(sessionId);
  const r = await autopilot.runCycle(db.get(), mockClient(), snap([]), { now });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'not_autopilot');
});

test('no active pool endpoint: the cycle safely no-ops', async () => {
  db.get().prepare('DELETE FROM pool_endpoints').run();
  const r = await autopilot.runCycle(db.get(), mockClient(), snap([]), { now });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no_endpoint');
});

test('runCycle: no client -> safe no-op (no_client)', async () => {
  const r = await autopilot.runCycle(db.get(), null, snap([]), { now });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no_client');
});

test('runCycle: a market fetch failure aborts the cycle without spending (market_fetch_failed)', async () => {
  const client = { async get() { throw new Error('MRR 500'); }, async put() { throw new Error('nope'); } };
  const r = await autopilot.runCycle(db.get(), client, snap([]), { now });   // empty -> below target -> reaches the fetch
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'market_fetch_failed');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'nothing rented when the market fetch fails');
});

test('runCycle: a real gap but no eligible market rigs runs the cycle yet rents nothing', async () => {
  const client = { async get(p) { if (p === '/rig') return { records: [], total: 0 }; throw new Error('x'); }, async put() { throw new Error('x'); } };
  const r = await autopilot.runCycle(db.get(), client, snap([]), { now });
  assert.equal(r.ran, true);
  assert.deepEqual(r.outcome, { executed: [], rehearsed: [] });
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
});
