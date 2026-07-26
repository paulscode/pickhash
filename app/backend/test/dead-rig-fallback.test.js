'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const fallback = require('../engine/dead-rig-fallback');
const config = require('../config');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-reroute-'));
before(() => db.open(DATA));
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

let sid;
beforeEach(() => {
  const c = db.get();
  for (const t of ['rentals', 'sessions', 'alerts', 'decisions', 'config', 'pool_endpoints']) c.prepare(`DELETE FROM ${t}`).run();
  config.set(c, 'strategy', { dead_rig_reroute_enabled: true, fallback_pool_enabled: true });
  c.prepare("INSERT INTO pool_endpoints (name,host,port,worker_base,mrr_profile_id,active) VALUES ('ep','node.example',3333,'bc1qaddr.wk',7,1)").run();
  sid = Number(c.prepare("INSERT INTO sessions (mode,state,created_at,started_at) VALUES ('autopilot','active',1,1)").run().lastInsertRowid);
  // A rig that's confirmed OFFLINE (dead on our pool) with a fired rental_offline alert...
  c.prepare("INSERT INTO rentals (session_id,mrr_id,rig_id,rig_name,advertised_th,length_hours,paid_sats,fee_sats,end_ts,ended,health,avg_percent,worker_name) VALUES (?,700,42,'DeadRig',205,8,3500,105,9999,0,'offline',0,'w')").run(sid);
  c.prepare("INSERT INTO alerts (kind,key,severity,state,armed_at,fired_at) VALUES ('rental_offline','700','warning','fired',1,1)").run();
  // ...alongside a healthy PEER on the same pool (proof the pool is fine and it's this rig).
  c.prepare("INSERT INTO rentals (session_id,mrr_id,rig_id,rig_name,advertised_th,length_hours,paid_sats,fee_sats,end_ts,ended,health,avg_percent,worker_name) VALUES (?,701,43,'GoodPeer',100,8,3500,105,9999,0,'healthy',99,'w')").run(sid);
});

function mockClient() { const puts = []; return { puts, async put(p, params) { puts.push([p, params]); return {}; } }; }

test('disabled by default -> no-op', async () => {
  config.set(db.get(), 'strategy', { dead_rig_reroute_enabled: false });
  assert.equal((await fallback.maybeReroute(db.get(), mockClient(), {}, { now: 1000 })).reason, 'disabled');
});

test('requires the Ocean fallback pool to be enabled', async () => {
  config.set(db.get(), 'strategy', { fallback_pool_enabled: false });
  assert.equal((await fallback.maybeReroute(db.get(), mockClient(), {}, { now: 1000 })).reason, 'no_fallback_pool');
});

test('skips when the endpoint itself is down (that is an endpoint problem, not a per-rig one)', async () => {
  db.get().prepare("INSERT INTO alerts (kind,key,severity,state,armed_at,fired_at) VALUES ('endpoint_down',NULL,'critical','fired',1,1)").run();
  const client = mockClient();
  assert.equal((await fallback.maybeReroute(db.get(), client, {}, { now: 1000 })).reason, 'endpoint_down');
  assert.equal(client.puts.length, 0, 'no reroute while the endpoint is down');
});

test('does NOT reroute when there is no healthy peer (can\'t prove it\'s the rig vs the pool)', async () => {
  const c = db.get();
  c.prepare('DELETE FROM rentals WHERE mrr_id = 701').run();   // remove the healthy peer
  config.set(c, 'run', { mode: 'live' });
  const client = mockClient();
  const r = await fallback.maybeReroute(c, client, {}, { now: 1000 });
  assert.equal(r.reason, 'no_healthy_peer');
  assert.equal(client.puts.length, 0, 'no reroute, no owner message without a proven-good peer');
  assert.equal(c.prepare('SELECT rerouted_ocean FROM rentals WHERE mrr_id = 700').get().rerouted_ocean, 0);
});

test('a degraded (not healthy) peer does NOT count as proof — still no reroute', async () => {
  const c = db.get();
  c.prepare("UPDATE rentals SET health = 'degraded' WHERE mrr_id = 701").run();
  config.set(c, 'run', { mode: 'live' });
  const client = mockClient();
  assert.equal((await fallback.maybeReroute(c, client, {}, { now: 1000 })).reason, 'no_healthy_peer');
  assert.equal(client.puts.length, 0);
});

test('a healthy peer already parked on Ocean does NOT count — it isn\'t proof YOUR pool serves jobs', async () => {
  const c = db.get();
  c.prepare('UPDATE rentals SET rerouted_ocean = 1 WHERE mrr_id = 701').run();   // the only healthy peer is on Ocean
  config.set(c, 'run', { mode: 'live' });
  const client = mockClient();
  assert.equal((await fallback.maybeReroute(c, client, {}, { now: 1000 })).reason, 'no_healthy_peer');
  assert.equal(client.puts.length, 0, 'no reroute + no false "same pool" message');
});

test('DRY-RUN reroute is deduped — no duplicate decision row on a repeat tick', async () => {
  const c = db.get();
  const r1 = await fallback.maybeReroute(c, mockClient(), {}, { now: 1000 });   // dry-run by default
  assert.equal(r1.decided, 'dry_run');
  const r2 = await fallback.maybeReroute(c, mockClient(), {}, { now: 1060 });
  assert.equal(r2.reason, 'no_candidate', 'already rehearsed -> nothing new');
  assert.equal(c.prepare("SELECT COUNT(*) n FROM decisions WHERE note = 'reroute_ocean:700:dry_run'").get().n, 1, 'exactly one dry-run row, not one per tick');
});

test('DRY-RUN records a would-reroute and mutates nothing', async () => {
  const client = mockClient();
  const r = await fallback.maybeReroute(db.get(), client, {}, { now: 1000 });   // run mode defaults to dry-run
  assert.equal(r.decided, 'dry_run');
  assert.equal(client.puts.length, 0, 'no MRR mutation in DRY-RUN');
  assert.equal(db.get().prepare('SELECT rerouted_ocean FROM rentals WHERE mrr_id = 700').get().rerouted_ocean, 0);
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'reroute_ocean:700:dry_run'").get());
});

test('LIVE reroutes the rental to Ocean (per-rental), messages the owner, flags it, and never re-does it', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = mockClient();
  const r = await fallback.maybeReroute(db.get(), client, {}, { now: 1000 });
  assert.equal(r.decided, 'rerouted');
  assert.equal(r.messaged, true);
  // pool/0 promoted to Ocean for THIS rental, with the .fallback-tagged Ocean worker.
  const pool = client.puts.find((p) => /\/rental\/700\/pool\/0$/.test(p[0]));
  assert.ok(pool, 'pool/0 override issued');
  assert.equal(pool[1].host, 'mine.ocean.xyz');
  assert.equal(pool[1].port, 3334);
  assert.equal(pool[1].user, 'bc1qaddr.fallback', 'Ocean worker is the BTC address + .fallback');
  // owner message captured on the rental thread — and only provable claims.
  const msg = client.puts.find((p) => /\/rental\/700\/message$/.test(p[0]));
  assert.ok(msg && /DeadRig/.test(msg[1].message), 'owner message names the rig');
  assert.match(msg[1].message, /mining normally/, 'asserts the verified healthy peer(s)');
  assert.match(msg[1].message, /0% of its advertised hashrate/, 'states the observed 0% delivery');
  assert.doesNotMatch(msg[1].message, /no jobs/, 'never claims the pool sent no jobs (it did — peers got them)');
  // marked + alerted.
  assert.equal(db.get().prepare('SELECT rerouted_ocean FROM rentals WHERE mrr_id = 700').get().rerouted_ocean, 1);
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'rig_rerouted' AND key = '700' AND state = 'fired'").get());
  // once-per-rental: a second pass finds nothing to do and issues no further calls.
  const before = client.puts.length;
  const r2 = await fallback.maybeReroute(db.get(), client, {}, { now: 1100 });
  assert.equal(r2.reason, 'no_candidate');
  assert.equal(client.puts.length, before, 'not rerouted again');
});

test('a message-send failure still leaves the reroute recorded (the pool move is the point)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = { async put(p) { if (/\/message$/.test(p)) throw new Error('msg down'); return {}; } };
  const r = await fallback.maybeReroute(db.get(), client, {}, { now: 1000 });
  assert.equal(r.decided, 'rerouted');
  assert.equal(r.messaged, false, 'message failed but reroute stands');
  assert.equal(db.get().prepare('SELECT rerouted_ocean FROM rentals WHERE mrr_id = 700').get().rerouted_ocean, 1);
});

test('a reroute PUT failure writes no marker so it retries next tick', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = { async put() { throw new Error('mrr down'); } };
  const r = await fallback.maybeReroute(db.get(), client, {}, { now: 1000 });
  assert.equal(r.reason, 'reroute_failed');
  assert.equal(db.get().prepare('SELECT rerouted_ocean FROM rentals WHERE mrr_id = 700').get().rerouted_ocean, 0, 'not flagged -> retries');
});
