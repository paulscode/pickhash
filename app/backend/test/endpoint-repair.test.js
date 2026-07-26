'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const er = require('../engine/endpoint-repair');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-erepair-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  c.prepare('DELETE FROM rentals').run();
  c.prepare('DELETE FROM sessions').run();
  c.prepare('DELETE FROM alerts').run();
  c.prepare('DELETE FROM pool_endpoints').run();
  c.prepare('INSERT INTO pool_endpoints (host, port, worker_base, stratum_diff, mrr_pool_id, mrr_profile_id, active) VALUES (?,?,?,?,?,?,1)')
    .run('198.51.100.1', 3333, 'bc1qx.phash', 131072, 111, 953073);
});

const stored = { host: '198.51.100.1', port: 3333 };
const hg = (host, port) => ({ reachable: true, publicEndpoint: host ? { host, port } : null });

// ---- planRepair (pure) ----

test('planRepair: no change when HashGG reports the same endpoint', () => {
  assert.equal(er.planRepair({ storedEndpoint: stored, endpointOk: false, hashgg: hg('198.51.100.1', 3333) }), null);
});

test('planRepair: leaves a still-delivering endpoint alone even if HashGG differs', () => {
  assert.equal(er.planRepair({ storedEndpoint: stored, endpointOk: true, hashgg: hg('198.51.100.4', 4444) }), null);
});

test('planRepair: null on unreachable HashGG / missing public endpoint / no stored endpoint', () => {
  assert.equal(er.planRepair({ storedEndpoint: stored, endpointOk: false, hashgg: { reachable: false, publicEndpoint: { host: '198.51.100.4', port: 4444 } } }), null);
  assert.equal(er.planRepair({ storedEndpoint: stored, endpointOk: false, hashgg: hg(null) }), null);
  assert.equal(er.planRepair({ storedEndpoint: null, endpointOk: false, hashgg: hg('198.51.100.4', 4444) }), null);
});

test('planRepair: repairs when the endpoint is down AND HashGG reports a new one', () => {
  const p = er.planRepair({ storedEndpoint: stored, endpointOk: false, hashgg: hg('198.51.100.4', 4444) });
  assert.deepEqual(p, { from: { host: '198.51.100.1', port: 3333 }, to: { host: '198.51.100.4', port: 4444 } });
});

// ---- repair (impure) ----

function seedRental(mrrId, worker) {
  const c = db.get();
  const existing = c.prepare("SELECT id FROM sessions WHERE state = 'active'").get();
  const sid = existing ? existing.id : Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('autopilot','active',1,1)").run().lastInsertRowid);
  c.prepare('INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (?,?,1,?,100,3,1000,30,1,999,0,?,?)')
    .run(sid, mrrId, 'r', 'healthy', worker);
}
function mockClient() {
  const state = { puts: [] };
  return { state, async put(p, params) { state.puts.push([p, params]); return { message: 'ok' }; } };
}
const PLAN = { from: stored, to: { host: '198.51.100.4', port: 4444 } };

test('repair updates the saved endpoint and re-points every active rental in LIVE', async () => {
  seedRental(501, 'bc1qx.phash-r501');
  seedRental(502, 'bc1qx.phash-r502');
  const client = mockClient();
  const r = await er.repair(db.get(), client, { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.rentals, 2);
  const ep = db.get().prepare('SELECT host, port FROM pool_endpoints WHERE active = 1').get();
  assert.equal(ep.host, '198.51.100.4');
  assert.equal(ep.port, 4444);
  const pools = client.state.puts.filter((p) => /\/pool\/0$/.test(p[0]));
  assert.equal(pools.length, 2);
  assert.equal(pools[0][1].host, '198.51.100.4');
  assert.equal(pools[0][1].port, 4444);
  assert.equal(pools[0][1].user, 'bc1qx.phash-r501', 'each rental keeps its own worker');
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'endpoint_repaired' AND state = 'fired'").get());
});

test('repair skips a rig parked on Ocean by dead-rig fallback (never yanks it back to the endpoint)', async () => {
  seedRental(501, 'bc1qx.phash-r501');
  seedRental(502, 'bc1qx.phash-r502');
  db.get().prepare('UPDATE rentals SET rerouted_ocean = 1 WHERE mrr_id = 502').run();   // 502 deliberately on Ocean
  const client = mockClient();
  const r = await er.repair(db.get(), client, { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.rentals, 1, 'only the un-parked rental is re-pointed');
  const pools = client.state.puts.filter((p) => /\/pool\/0$/.test(p[0]));
  assert.equal(pools.length, 1);
  assert.match(pools[0][0], /\/rental\/501\/pool\/0$/, '502 (parked on Ocean) is left alone');
});

test('repair updates the saved endpoint but issues NO MRR mutation in DRY-RUN', async () => {
  seedRental(503, 'bc1qx.phash-r503');
  const client = mockClient();
  await er.repair(db.get(), client, { plan: PLAN, runMode: 'dry-run', now: 1000 });
  assert.equal(client.state.puts.length, 0, 'no MRR mutation in DRY-RUN');
  assert.equal(db.get().prepare('SELECT host FROM pool_endpoints WHERE active = 1').get().host, '198.51.100.4', 'local endpoint still converges');
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'endpoint_repaired'").get());
});

test('a failed re-point PUT leaves the saved endpoint UNCHANGED so it retries next tick', async () => {
  seedRental(504, 'bc1qx.phash-r504');
  const client = { async put(p) { if (/\/pool\/0$/.test(p)) throw new Error('MRR 500'); throw new Error('unexpected ' + p); } };
  const r = await er.repair(db.get(), client, { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.failed, 1);
  const ep = db.get().prepare('SELECT host, port FROM pool_endpoints WHERE active = 1').get();
  assert.equal(ep.host, '198.51.100.1', 'saved endpoint NOT converged while a rental is stranded');
  assert.equal(ep.port, 3333);
  // Because stored stayed old, planRepair still returns a plan -> it will retry.
  assert.ok(er.planRepair({ storedEndpoint: ep, endpointOk: false, hashgg: hg('198.51.100.4', 4444) }), 'retry armed');
});

test('repair is idempotent: once the saved endpoint matches HashGG, planRepair stops', async () => {
  await er.repair(db.get(), mockClient(), { plan: PLAN, runMode: 'live', now: 1000 });
  const now = db.get().prepare('SELECT host, port FROM pool_endpoints WHERE active = 1').get();
  assert.equal(er.planRepair({ storedEndpoint: now, endpointOk: false, hashgg: hg('198.51.100.4', 4444) }), null);
});

test('a MIX of one failed and one successful re-point leaves the saved endpoint UNCHANGED (retry next tick)', async () => {
  seedRental(601, 'bc1qx.phash-r601');
  seedRental(602, 'bc1qx.phash-r602');
  const client = {
    state: { puts: [] },
    async put(p, params) {
      this.state.puts.push([p, params]);
      if (/\/rental\/601\/pool\/0$/.test(p)) throw new Error('MRR 500');   // one rental's re-point fails
      return { message: 'ok' };                                            // the other succeeds
    },
  };
  const r = await er.repair(db.get(), client, { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.rentals, 1, 'exactly one re-point succeeded');
  assert.equal(r.failed, 1, 'exactly one re-point failed');
  const ep = db.get().prepare('SELECT host, port FROM pool_endpoints WHERE active = 1').get();
  assert.equal(ep.host, '198.51.100.1', 'saved endpoint stays OLD while a rental is stranded (failed > 0)');
  assert.equal(ep.port, 3333);
});

test('a winding_down session rental is still re-pointed (the repair query includes winding_down)', async () => {
  const c = db.get();
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('autopilot','winding_down',1,1)").run().lastInsertRowid);
  c.prepare('INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (?,701,1,?,100,3,1000,30,1,999,0,?,?)')
    .run(sid, 'r', 'healthy', 'bc1qx.phash-r701');
  const client = mockClient();
  const r = await er.repair(c, client, { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.rentals, 1, 'the winding_down rental was re-pointed');
  assert.equal(client.state.puts.filter((p) => /\/rental\/701\/pool\/0$/.test(p[0])).length, 1);
});

test('planRepair: a port-only change still repairs', () => {
  const p = er.planRepair({ storedEndpoint: stored, endpointOk: false, hashgg: hg('198.51.100.1', 5555) });
  assert.deepEqual(p, { from: { host: '198.51.100.1', port: 3333 }, to: { host: '198.51.100.1', port: 5555 } });
});

test('planRepair: null when the public endpoint port is not positive', () => {
  assert.equal(er.planRepair({ storedEndpoint: stored, endpointOk: false, hashgg: hg('198.51.100.4', 0) }), null);
});

test('repair with zero active rentals still converges the saved endpoint', async () => {
  const r = await er.repair(db.get(), mockClient(), { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.rentals, 0);
  assert.equal(r.failed, 0);
  assert.equal(db.get().prepare('SELECT host FROM pool_endpoints WHERE active = 1').get().host, '198.51.100.4');
});

test('repair in LIVE with a null client issues no PUTs but still converges the endpoint', async () => {
  seedRental(605, 'bc1qx.phash-r605');
  const r = await er.repair(db.get(), null, { plan: PLAN, runMode: 'live', now: 1000 });
  assert.equal(r.rentals, 0, 'no PUTs without a client');
  assert.equal(r.failed, 0);
  assert.equal(db.get().prepare('SELECT host FROM pool_endpoints WHERE active = 1').get().host, '198.51.100.4', 'endpoint still converges');
});

test('repair REFUSES to re-point rentals at a blocked (internal/metadata) endpoint', async () => {
  seedRental(701, 'bc1qx.phash-r701');
  const client = mockClient();
  const before = db.get().prepare('SELECT host, port FROM pool_endpoints WHERE active = 1').get();
  // A spoofed/MITM'd HashGG claiming the cloud-metadata address must NOT redirect paid hashrate.
  const r = await er.repair(db.get(), client, { plan: { from: stored, to: { host: '169.254.169.254', port: 4444 } }, runMode: 'live', now: 2000 });
  assert.equal(r.blocked, true, 'repair reported it was blocked');
  assert.equal(client.state.puts.length, 0, 'no rental was re-pointed');
  const after = db.get().prepare('SELECT host, port FROM pool_endpoints WHERE active = 1').get();
  assert.deepEqual(after, before, 'the saved endpoint is left unchanged');
});
