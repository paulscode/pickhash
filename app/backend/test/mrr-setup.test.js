'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// The data dir must be set before requiring the server (it reads DATA_DIR at load),
// and must match the DB we open so the secret.key lives alongside it.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-mrrkeys-'));
process.env.DATA_DIR = DATA;

const server = require('../server');
const db = require('../db');
const { isConfigured } = require('../api');
const config = require('../config');
const { createMockServer } = require('../../../scripts/mrr-mock');

let appServer;
let appPort;
let mockServer;
let scenarioFn = () => null;   // per-test override of the mock's /whoami response

function listen(s) { return new Promise((r) => s.listen(0, () => r(s.address().port))); }

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port: appPort, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null })); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  db.open(DATA);
  mockServer = createMockServer({ scenario: (c) => scenarioFn(c) });
  const mockPort = await listen(mockServer);
  process.env.MRR_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.ALLOW_INSECURE_MRR = '1';   // permit the plaintext mock base in tests only
  process.env.DASHBOARD_PASSWORD = 'x';    // managed -> satisfies the password-before-setup gate
  appServer = http.createServer(server.handleRequest);
  appPort = await listen(appServer);
});

after(async () => {
  delete process.env.MRR_BASE_URL;
  delete process.env.ALLOW_INSECURE_MRR;
  delete process.env.DASHBOARD_PASSWORD;
  mockServer.closeAllConnections?.();
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('mrr-keys: missing fields, auth failure, and rent-permission are rejected without persisting', async () => {
  let r = await call('POST', '/api/setup/mrr-keys', { key: '', secret: '' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'key_and_secret_required');

  // whoami fails -> auth_failed, nothing stored.
  scenarioFn = ({ path }) => (path === '/whoami' ? { json: { success: false, data: { message: 'invalid signature' } } } : null);
  r = await call('POST', '/api/setup/mrr-keys', { key: 'K', secret: 'BAD' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'auth_failed');
  assert.equal(isConfigured(db.get()), false, 'bad credentials must not be persisted');

  // whoami ok but no rent permission -> rejected, nothing stored.
  scenarioFn = ({ path }) => (path === '/whoami'
    ? { json: { success: true, data: { userid: '1', permissions: { withdraw: 'read', rent: 'no', rigs: 'read' } } } } : null);
  r = await call('POST', '/api/setup/mrr-keys', { key: 'K', secret: 'S' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'rent_permission_required');
  assert.equal(isConfigured(db.get()), false);
});

test('mrr-keys: a valid rent-only key is stored and reports non-capable withdraw', async () => {
  scenarioFn = () => null;   // mock serves the recorded whoami fixture (withdraw:read, rent:yes, rigs:read)
  const r = await call('POST', '/api/setup/mrr-keys', { key: 'REALKEY', secret: 'REALSECRET' });
  assert.equal(r.status, 200);
  assert.equal(r.json.permissions.rent, 'yes');
  assert.equal(r.json.withdraw_capable, false, 'a read-only withdraw grant is not "capable"');
  assert.equal(isConfigured(db.get()), true, 'credentials persisted');
  // Credentials are stored ENCRYPTED (not plaintext) and the mrr config records the user.
  const blob = db.get().prepare("SELECT blob FROM secrets WHERE name='mrr_secret'").get().blob;
  assert.doesNotMatch(blob.toString('latin1'), /REALSECRET/, 'secret is encrypted at rest');
  assert.ok(config.getKey(db.get(), 'mrr', 'userid'));
});

test('mrr-keys: storing a key resets run mode to DRY-RUN and clears the LIVE confirmation', async () => {
  config.set(db.get(), 'run', { mode: 'live', live_confirmed: true });   // pretend we were already LIVE
  scenarioFn = () => null;
  await call('POST', '/api/setup/mrr-keys', { key: 'REALKEY', secret: 'REALSECRET' });
  assert.equal(config.getKey(db.get(), 'run', 'mode'), 'dry-run', 'a key change drops back to DRY-RUN');
  assert.equal(config.getKey(db.get(), 'run', 'live_confirmed'), false, 'LIVE confirmation must be re-earned for the new key');
});

test('mrr-keys: a withdraw-capable key is flagged for the LIVE gate', async () => {
  scenarioFn = ({ path }) => (path === '/whoami'
    ? { json: { success: true, data: { userid: '2', username: 'x', permissions: { withdraw: 'yes', rent: 'yes', rigs: 'read' } } } } : null);
  const r = await call('POST', '/api/setup/mrr-keys', { key: 'K', secret: 'S' });
  assert.equal(r.status, 200);
  assert.equal(r.json.withdraw_capable, true);
  assert.equal(config.getKey(db.get(), 'mrr', 'withdraw_capable'), true);
});

test('deposit endpoint returns the address + balance and is read-only (no writes)', async () => {
  scenarioFn = () => null;   // mock serves the account + balance fixtures
  const r = await call('GET', '/api/setup/deposit');
  assert.equal(r.status, 200);
  assert.match(r.json.address, /^bc1q/);
  assert.equal(r.json.confirmed_sats, 50000);      // from the balance fixture
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 0, 'a GET writes no alerts');
});

test('the MRR client is a shared singleton (nonce safety)', () => {
  const mrr = require('../mrr');
  const a = mrr.clientFromStore(db.get(), DATA);
  const b = mrr.clientFromStore(db.get(), DATA);
  assert.ok(a && a === b, 'clientFromStore returns the same instance across calls');
});

test('bootstrap endpoint ensures the pool + profile via the stored key', async () => {
  scenarioFn = () => null;   // mock serves the pool/profile fixtures
  db.get().prepare('INSERT INTO pool_endpoints (host, port, worker_base, active) VALUES (?, ?, ?, 1)')
    .run('host.example', 26596, 'bc1qaddr.phash');
  const r = await call('POST', '/api/setup/bootstrap');
  assert.equal(r.status, 200);
  assert.ok(r.json.pool_id);
  assert.ok(r.json.profile_id);
  const row = db.get().prepare('SELECT mrr_pool_id, mrr_profile_id FROM pool_endpoints WHERE active = 1').get();
  assert.equal(String(row.mrr_pool_id), String(r.json.pool_id));   // INTEGER column vs string id
});
