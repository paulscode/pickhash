'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-rehearsal-'));
process.env.DATA_DIR = DATA;

const server = require('../server');
const db = require('../db');
const config = require('../config');

let appServer;
let appPort;
function listen(s) { return new Promise((r) => s.listen(0, () => r(s.address().port))); }
function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: appPort, path: p }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }));
    }).on('error', reject);
  });
}
function insertSession(mode) {
  return Number(db.get().prepare(
    `INSERT INTO sessions (mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at)
       VALUES (?, 'active', 10, 50000, 0, 0, 1000, 1000)`,
  ).run(mode).lastInsertRowid);
}
function wouldRent(sessionId, ts, rig, name, cost) {
  db.get().prepare('INSERT INTO decisions (algo, ts, session_id, dry_run, executed_json, note) VALUES (?, ?, ?, 1, ?, ?)')
    .run('sha256ab', ts, sessionId, JSON.stringify({ would_rent: true, rig, name, region: 'us-east', advertised_th: 2, length: 3, cost_sats: cost }), `AUTOPILOT DRY-RUN would rent rig #${rig} (${name}) for 3h at ${cost} sats`);
}

before(async () => {
  db.open(DATA);
  config.set(db.get(), 'setup', { completed: true });
  appServer = http.createServer(server.handleRequest);
  appPort = await listen(appServer);
});
after(async () => {
  await new Promise((r) => appServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('/api/status carries the latest rehearsal tick of an autopilot DRY-RUN session', async () => {
  const sid = insertSession('autopilot');
  // Two ticks; the second is the one the panel should show, in insertion order, summed.
  wouldRent(sid, 2000, 11, 'old rig', 100);
  wouldRent(sid, 2060, 21, '<img src=x onerror=alert(1)>', 1418);
  wouldRent(sid, 2060, 22, 'Sauron', 2164);
  // An intent row on the same tick without would_rent must not be counted.
  db.get().prepare('INSERT INTO decisions (algo, ts, session_id, dry_run, executed_json, note) VALUES (?, ?, ?, 1, ?, ?)')
    .run('sha256ab', 2060, sid, JSON.stringify({ failed: true, rig: 23 }), 'rig_failed');
  const r = await get('/api/status');
  assert.equal(r.status, 200);
  const rh = r.json.rehearsal;
  assert.ok(rh, 'rehearsal block present');
  assert.equal(rh.ts, 2060);
  assert.equal(rh.ticks, 2);
  assert.deepEqual(rh.rows.map((x) => x.rig_id), [21, 22]);
  assert.equal(rh.rows[0].rig_name, '<img src=x onerror=alert(1)>', 'third-party name passed verbatim (the client binds it with x-text)');
  assert.equal(rh.rows[1].length_hours, 3);
  assert.equal(rh.total_sats, 1418 + 2164);
  db.get().prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(sid);
});

test('/api/status has no rehearsal block for a session without rehearsed rows', async () => {
  const sid = insertSession('autopilot');
  const r = await get('/api/status');
  assert.equal(r.status, 200);
  assert.ok(r.json.session && r.json.session.id === sid);
  assert.equal(r.json.rehearsal, null);
  db.get().prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(sid);
});
