'use strict';
// Platform-managed dashboard password (StartOS Configure screen passes DASHBOARD_PASSWORD).
// Runs in its own process (node --test isolates files), so setting the env here does not
// leak into the other auth suites.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-authmgd-'));
process.env.DATA_DIR = DATA;
const db = require('../db');
const auth = require('../auth');
const server = require('../server');

let appServer;
let appPort;

function call(method, p, { body, cookie, csrf } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    const r = http.request({ host: '127.0.0.1', port: appPort, path: p, method, headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null, setCookie: res.headers['set-cookie'] }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  db.open(DATA);
  appServer = http.createServer(server.handleRequest);
  appPort = await new Promise((r) => appServer.listen(0, () => r(appServer.address().port)));
});
after(async () => {
  await new Promise((r) => appServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  delete process.env.DASHBOARD_PASSWORD;
});

test('applyManagedPassword: no env -> not managed, nothing stored', () => {
  delete process.env.DASHBOARD_PASSWORD;
  const conn = db.get();
  assert.equal(auth.isManaged(), false);
  assert.equal(auth.applyManagedPassword(conn), false);
  assert.equal(auth.passwordEnabled(conn), false);
});

test('applyManagedPassword: seeds from env, is idempotent, and rotates on change', () => {
  const conn = db.get();
  process.env.DASHBOARD_PASSWORD = 'platform-seeded-token-abc123';
  assert.equal(auth.isManaged(), true);
  assert.equal(auth.applyManagedPassword(conn), true);
  assert.equal(auth.passwordEnabled(conn), true);
  assert.equal(auth.verifyCurrent(conn, 'platform-seeded-token-abc123'), true);

  // Idempotent: an unchanged env password re-hashes nothing.
  const blobBefore = conn.prepare("SELECT blob FROM secrets WHERE name='dashboard_password'").get().blob;
  auth.applyManagedPassword(conn);
  const blobAfter = conn.prepare("SELECT blob FROM secrets WHERE name='dashboard_password'").get().blob;
  assert.deepEqual(blobAfter, blobBefore, 'no re-hash when the managed password is unchanged');

  // Rotating the platform value updates the stored password.
  process.env.DASHBOARD_PASSWORD = 'rotated-token-xyz789';
  auth.applyManagedPassword(conn);
  assert.equal(auth.verifyCurrent(conn, 'rotated-token-xyz789'), true);
  assert.equal(auth.verifyCurrent(conn, 'platform-seeded-token-abc123'), false);
});

test('API: auth/state exposes managed=true; login works; in-app set-password is refused', async () => {
  process.env.DASHBOARD_PASSWORD = 'rotated-token-xyz789';
  auth.applyManagedPassword(db.get());

  const anon = await call('GET', '/api/auth/state');
  assert.equal(anon.json.password_enabled, true);
  assert.equal(anon.json.managed, true);
  assert.equal(anon.json.authed, false);

  const login = await call('POST', '/api/auth/login', { body: { password: 'rotated-token-xyz789' } });
  assert.equal(login.status, 200);
  const cookie = login.setCookie[0].split(';')[0];
  const csrf = login.json.csrf;

  // An in-app change would be clobbered on next boot, so it is rejected outright.
  const change = await call('POST', '/api/auth/set-password', { cookie, csrf, body: { password: 'user-tries-to-change' } });
  assert.equal(change.status, 400);
  assert.equal(change.json.error, 'password_managed_externally');
});

test('applyManagedPassword clears a login lockout when the managed password CHANGES (owner recovery)', async () => {
  const conn = db.get();
  const config = require('../config');
  // Simulate a locked-out account.
  config.set(conn, 'auth', { fail_count: 9, locked_until: Math.floor(Date.now() / 1000) + 999 });
  // Re-applying the SAME managed password must NOT clear the lockout (a crash/restart mustn't bypass it).
  process.env.DASHBOARD_PASSWORD = 'rotated-token-xyz789';
  auth.applyManagedPassword(conn);
  assert.ok(auth.lockState(conn).lockedUntil > Math.floor(Date.now() / 1000), 'same password -> lockout preserved');
  // CHANGING it (an owner action on the platform config screen) clears the lockout.
  process.env.DASHBOARD_PASSWORD = 'owner-picked-a-new-one';
  auth.applyManagedPassword(conn);
  assert.equal(auth.lockState(conn).lockedUntil, 0, 'changed password -> lockout cleared');
  assert.equal(auth.lockState(conn).failCount, 0);
});
