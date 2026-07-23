'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const server = require('../server');
const db = require('../db');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-setup-'));
let httpServer;
let port;

// A single keep-alive connection, to prove the handoff happens without dropping it.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port, path: p, method, agent, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null, socket: res.socket }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  db.open(DATA);
  httpServer = http.createServer(server.handleRequest);
  port = await new Promise((r) => httpServer.listen(0, () => r(httpServer.address().port)));
});

after(async () => {
  agent.destroy();
  await new Promise((r) => httpServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('setup gate closes the app API and hands off in place after completion', async () => {
  // 1. Before setup: state reflects nothing configured, app API is 412.
  let r = await req('GET', '/api/setup/state');
  assert.deepEqual(r.json, { configured: false, completed: false });
  const sock1 = r.socket;

  r = await req('GET', '/api/status');
  assert.equal(r.status, 412);
  assert.equal(r.json.needs_setup, true);

  // 2. Completing before MRR keys exist is rejected.
  r = await req('POST', '/api/setup/complete');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'mrr_not_configured');

  // 3. Simulate the MRR-keys step storing an encrypted credential.
  db.get().prepare('INSERT INTO secrets (name, blob, updated_at) VALUES (?, ?, ?)')
    .run('mrr_key', Buffer.from('dummy-encrypted'), 1);
  r = await req('GET', '/api/setup/state');
  assert.deepEqual(r.json, { configured: true, completed: false });
  r = await req('GET', '/api/status');
  assert.equal(r.status, 412, 'still gated until the wizard is explicitly completed');

  // 4. Completing is refused until the pool/profile bootstrap has run (no usable pool).
  r = await req('POST', '/api/setup/complete');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'setup_incomplete');

  // Simulate the pool step + bootstrap: an active endpoint with a profile id.
  db.get().prepare('INSERT INTO pool_endpoints (host, port, worker_base, mrr_profile_id, active) VALUES (?, ?, ?, ?, 1)')
    .run('host.example', 26596, 'bc1q.w', 7000002);

  // Now completion succeeds — and flips the flag on the same running server.
  r = await req('POST', '/api/setup/complete');
  assert.equal(r.status, 200);
  assert.equal(r.json.completed, true);

  // 5. The app API is now open — on the SAME keep-alive connection, no restart.
  r = await req('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.socket, sock1, 'the handoff reused the original connection (no drop/restart)');
});
