'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const nudge = require('../engine/owner-nudge');
const config = require('../config');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-nudge-'));
before(() => db.open(DATA));
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

let sid;
beforeEach(() => {
  const c = db.get();
  for (const t of ['rentals', 'sessions', 'alerts', 'decisions', 'config']) c.prepare(`DELETE FROM ${t}`).run();
  config.set(c, 'strategy', { owner_nudge_enabled: true });
  sid = Number(c.prepare("INSERT INTO sessions (mode,state,created_at,started_at) VALUES ('autopilot','active',1,1)").run().lastInsertRowid);
  c.prepare("INSERT INTO rentals (session_id,mrr_id,rig_id,rig_name,advertised_th,length_hours,paid_sats,fee_sats,end_ts,ended,health,avg_percent,worker_name) VALUES (?,700,42,'BadRig',100,3,1000,30,9999,0,'degraded',82,'w')").run(sid);
  c.prepare("INSERT INTO alerts (kind,key,severity,state,armed_at,fired_at) VALUES ('rental_underdelivering','700','warning','fired',1,1)").run();
});

function mockClient() { const puts = []; return { puts, async put(p, params) { puts.push([p, params]); return {}; } }; }

test('disabled by default -> no-op', async () => {
  config.set(db.get(), 'strategy', { owner_nudge_enabled: false });
  assert.equal((await nudge.maybeNudge(db.get(), mockClient(), { now: 1000 })).reason, 'disabled');
});

test('DRY-RUN records a would-send and sends nothing', async () => {
  const client = mockClient();
  const r = await nudge.maybeNudge(db.get(), client, { now: 1000 });   // run mode defaults to dry-run
  assert.equal(r.decided, 'dry_run');
  assert.equal(client.puts.length, 0, 'no real message sent in DRY-RUN');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'owner_nudge:700:dry_run'").get());
});

test('LIVE sends the templated message once, marks it, and never re-sends the same rental', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = mockClient();
  const r = await nudge.maybeNudge(db.get(), client, { now: 1000 });
  assert.equal(r.decided, 'sent');
  assert.equal(client.puts.length, 1);
  assert.match(client.puts[0][0], /\/rental\/700\/message$/);
  assert.match(client.puts[0][1].message, /BadRig/, 'templated body names the rig');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'owner_nudge:700:sent'").get());
  const r2 = await nudge.maybeNudge(db.get(), client, { now: 1100 });
  assert.equal(r2.reason, 'no_candidate', 'already nudged -> not a candidate');
  assert.equal(client.puts.length, 1, 'not sent again');
});

test('no fired underdelivering alert -> no candidate', async () => {
  db.get().prepare('DELETE FROM alerts').run();
  assert.equal((await nudge.maybeNudge(db.get(), mockClient(), { now: 1000 })).reason, 'no_candidate');
});

test('also nudges a fully-OFFLINE rig (rental_offline), not just degraded', async () => {
  const c = db.get();
  c.prepare('DELETE FROM alerts').run();
  c.prepare("INSERT INTO alerts (kind,key,severity,state,armed_at,fired_at) VALUES ('rental_offline','700','warning','fired',1,1)").run();
  config.set(c, 'run', { mode: 'live' });
  const client = mockClient();
  const r = await nudge.maybeNudge(c, client, { now: 1000 });
  assert.equal(r.decided, 'sent', 'a dead (0%) rig fires rental_offline and must still be nudged');
  assert.equal(client.puts.length, 1);
});

test('a DRY-RUN rehearsal does NOT suppress the later LIVE send (mode-aware dedup)', async () => {
  const c = db.get();
  const r1 = await nudge.maybeNudge(c, mockClient(), { now: 1000 });   // dry-run (default)
  assert.equal(r1.decided, 'dry_run');
  config.set(c, 'run', { mode: 'live' });
  const client = mockClient();
  const r2 = await nudge.maybeNudge(c, client, { now: 1100 });
  assert.equal(r2.decided, 'sent', 'the dry_run marker must not block the real send');
  assert.equal(client.puts.length, 1);
});
