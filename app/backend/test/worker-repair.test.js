'use strict';
/*
 * Correcting the stratum username on rentals that are already running.
 *
 * The failure this exists for is invisible from inside the app: a pool that cannot parse
 * an address out of the old `<base>-r<id>` form still serves work, so MRR records full
 * delivery and health stays green while the hashrate is credited to nobody. There is no
 * under-delivery to detect and no refund to claim — the only fix is to correct the name
 * on the live rental, which is what this does.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const wr = require('../engine/worker-repair');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-wrepair-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

const ENDPOINT = { host: '198.51.100.1', port: 3333, worker_base: 'bc1qx.phash' };

beforeEach(() => {
  const c = db.get();
  c.prepare('DELETE FROM rentals').run();
  c.prepare('DELETE FROM sessions').run();
  c.prepare('DELETE FROM alerts').run();
  c.prepare('DELETE FROM decisions').run();
});

function seedRental(mrrId, worker, opts = {}) {
  const c = db.get();
  const existing = c.prepare("SELECT id FROM sessions WHERE state = 'active'").get();
  const sid = existing ? existing.id
    : Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('autopilot','active',1,1)").run().lastInsertRowid);
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats,
                                  start_ts, end_ts, ended, health, worker_name, stratum_pass, rerouted_ocean)
             VALUES (?,?,1,'r',100,3,1000,30,1,999,?,'healthy',?,?,?)`)
    .run(sid, mrrId, opts.ended ? 1 : 0, worker, opts.pass || 'x', opts.rerouted ? 1 : 0);
  return sid;
}
function mockClient(fail = () => false) {
  const state = { puts: [] };
  return { state, async put(p, params) { if (fail(p)) throw new Error('nope'); state.puts.push([p, params]); return { message: 'ok' }; } };
}
const workerOf = (mrrId) => db.get().prepare('SELECT worker_name FROM rentals WHERE mrr_id = ?').get(mrrId).worker_name;

// ---- planWorkerRepairs (pure read) ----

test('plans a repair for the old dash form, and nothing for a name already correct', () => {
  seedRental(801, 'bc1qx.phash-r801');
  seedRental(802, 'bc1qx.r802');
  const plan = wr.planWorkerRepairs(db.get(), ENDPOINT);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].mrr_id, 801);
  assert.equal(plan[0].from, 'bc1qx.phash-r801');
  assert.equal(plan[0].to, 'bc1qx.r801');
});

test('leaves ended rentals and rigs parked on the fallback pool alone', () => {
  seedRental(803, 'bc1qx.phash-r803', { ended: true });
  // Deliberately moved to a DIFFERENT pool with a .fallback worker; not stale, and
  // dragging it back to the endpoint is exactly what dead-rig fallback moved it off.
  seedRental(804, 'bc1qx.fallback', { rerouted: true });
  assert.deepEqual(wr.planWorkerRepairs(db.get(), ENDPOINT), []);
});

test('no endpoint, or one with no address, plans nothing rather than a worse name', () => {
  seedRental(805, 'bc1qx.phash-r805');
  assert.deepEqual(wr.planWorkerRepairs(db.get(), null), []);
  assert.deepEqual(wr.planWorkerRepairs(db.get(), { ...ENDPOINT, worker_base: '.phash' }), []);
});

// ---- repairWorkers (impure) ----

test('LIVE: re-points the rental, keeps its difficulty password, and records the correction', async () => {
  const sid = seedRental(806, 'bc1qx.phash-r806', { pass: 'd=8192' });
  const client = mockClient();
  const r = await wr.repairWorkers(db.get(), client, { endpoint: ENDPOINT, runMode: 'live', now: 1_000_000 });

  assert.deepEqual({ ran: r.ran, repaired: r.repaired, failed: r.failed }, { ran: true, repaired: 1, failed: 0 });
  assert.equal(client.state.puts.length, 1);
  const [route, body] = client.state.puts[0];
  assert.match(route, /\/rental\/806\/pool\/0$/);
  assert.equal(body.user, 'bc1qx.r806');
  assert.equal(body.pass, 'd=8192', 'the per-rig difficulty survives the correction');
  assert.equal(body.host, ENDPOINT.host);
  assert.equal(workerOf(806), 'bc1qx.r806', 'the stored name is updated so it is not repaired again');

  const note = db.get().prepare('SELECT note FROM decisions WHERE session_id = ?').get(sid).note;
  assert.equal(note, 'worker_repair:806:bc1qx.phash-r806->bc1qx.r806');
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'worker_repaired'").get().n, 1);
});

test('idempotent: a second pass finds nothing and writes nothing', async () => {
  seedRental(807, 'bc1qx.phash-r807');
  const client = mockClient();
  await wr.repairWorkers(db.get(), client, { endpoint: ENDPOINT, runMode: 'live', now: 1 });
  const after = await wr.repairWorkers(db.get(), client, { endpoint: ENDPOINT, runMode: 'live', now: 2 });
  assert.equal(after.ran, false);
  assert.equal(after.reason, 'nothing_stale');
  assert.equal(client.state.puts.length, 1, 'no second PUT for a rental already corrected');
});

test('a failed PUT leaves the stored name alone, so the next tick retries it', async () => {
  seedRental(808, 'bc1qx.phash-r808');
  seedRental(809, 'bc1qx.phash-r809');
  // 808 fails, 809 succeeds: a partial failure must not strand the one that failed.
  const client = mockClient((p) => /\/rental\/808\//.test(p));
  const r = await wr.repairWorkers(db.get(), client, { endpoint: ENDPOINT, runMode: 'live', now: 1 });
  assert.deepEqual({ repaired: r.repaired, failed: r.failed }, { repaired: 1, failed: 1 });
  assert.equal(workerOf(808), 'bc1qx.phash-r808', 'unchanged, so it re-plans');
  assert.equal(workerOf(809), 'bc1qx.r809');
  assert.equal(wr.planWorkerRepairs(db.get(), ENDPOINT).length, 1, '808 is still queued for the next tick');
});

test('DRY-RUN rehearses only — a paid rental is never re-pointed outside LIVE', async () => {
  seedRental(810, 'bc1qx.phash-r810');
  const client = mockClient();
  const r = await wr.repairWorkers(db.get(), client, { endpoint: ENDPOINT, runMode: 'dry-run', now: 1 });
  assert.deepEqual({ ran: r.ran, reason: r.reason, stale: r.stale }, { ran: false, reason: 'dry_run', stale: 1 });
  assert.equal(client.state.puts.length, 0);
  assert.equal(workerOf(810), 'bc1qx.phash-r810');
});

test('an address change under a running session is repaired the same way', async () => {
  // The other shape of the same bug: rentals keep paying an address the user has moved off.
  seedRental(811, 'bc1qold.r811');
  const client = mockClient();
  await wr.repairWorkers(db.get(), client, { endpoint: { ...ENDPOINT, worker_base: 'bc1qnew' }, runMode: 'live', now: 1 });
  assert.equal(workerOf(811), 'bc1qnew.r811');
  const ctx = JSON.parse(db.get().prepare("SELECT context_json FROM alerts WHERE kind = 'worker_repaired'").get().context_json);
  assert.equal(ctx.address_changed, true, 'the notice says the address moved, not that a name was broken');
  assert.equal(ctx.address, 'bc1qnew');
});

test('a rental left on the shared worker by a failed override is planned for repair', () => {
  // rentOne records worker_base when its pool/0 override fails; that has to read as stale.
  seedRental(9301, ENDPOINT.worker_base);
  const plan = wr.planWorkerRepairs(db.get(), ENDPOINT);
  assert.deepEqual(plan.map((p) => [p.mrr_id, p.to]), [[9301, 'bc1qx.r9301']]);
});
