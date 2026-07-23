'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-auth-'));
process.env.DATA_DIR = DATA;
const server = require('../server');
const db = require('../db');
const auth = require('../auth');

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
});

let cookie;
let csrf;

test('open when no password: a mutating route reaches its handler without auth', async () => {
  const r = await call('POST', '/api/setup/complete');
  assert.equal(r.status, 400);                 // mrr_not_configured — reached the handler, not blocked
  assert.equal(r.json.error, 'mrr_not_configured');
});

test('set-password enables auth and logs the user in', async () => {
  assert.equal((await call('POST', '/api/auth/set-password', { body: { password: 'short' } })).status, 400);
  const r = await call('POST', '/api/auth/set-password', { body: { password: 'a-good-password' } });
  assert.equal(r.status, 200);
  assert.ok(r.setCookie && r.setCookie[0].startsWith('pickhash_session='));
  assert.match(r.setCookie[0], /HttpOnly/);
  assert.match(r.setCookie[0], /SameSite=Lax/);
  cookie = r.setCookie[0].split(';')[0];
  csrf = r.json.csrf;
  assert.ok(csrf);
});

test('gated: no cookie -> 401; cookie without CSRF on POST -> 403; cookie+CSRF -> handler', async () => {
  assert.equal((await call('POST', '/api/setup/complete')).status, 401);
  assert.equal((await call('POST', '/api/setup/complete', { cookie })).status, 403);
  assert.equal((await call('POST', '/api/setup/complete', { cookie, csrf })).status, 400);   // reached handler
  assert.equal((await call('GET', '/api/status')).status, 401);                              // reads need the session too
});

test('auth/state reflects password-enabled and authenticated', async () => {
  const anon = await call('GET', '/api/auth/state');
  assert.equal(anon.json.password_enabled, true);
  assert.equal(anon.json.authed, false);
  const authed = await call('GET', '/api/auth/state', { cookie });
  assert.equal(authed.json.authed, true);
  assert.equal(authed.json.csrf, csrf);
});

test('changing the password requires the current one', async () => {
  // Wrong current password -> rejected.
  let r = await call('POST', '/api/auth/set-password', { cookie, csrf, body: { password: 'a-good-password', current_password: 'nope' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'wrong_current_password');
  // Correct current password -> accepted (set to the same value so later tests are unaffected).
  r = await call('POST', '/api/auth/set-password', { cookie, csrf, body: { password: 'a-good-password', current_password: 'a-good-password' } });
  assert.equal(r.status, 200);
});

test('repeated wrong passwords trigger a persisted GLOBAL lockout', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await call('POST', '/api/auth/login', { body: { password: 'wrong' } })).status, 401);
  }
  // Now locked: even the correct password is refused, with a retry hint.
  const locked = await call('POST', '/api/auth/login', { body: { password: 'a-good-password' } });
  assert.equal(locked.status, 429);
  assert.ok(locked.json.retry_after > 0);
  // The lockout lives in the DB, so losing the in-memory sessions (a restart) doesn't reset it.
  auth._reset();
  assert.ok(auth.lockState(db.get()).lockedUntil > Math.floor(Date.now() / 1000), 'lockout persisted across restart');
});

test('the change-password current-check shares the global lockout (not an unthrottled oracle)', async () => {
  // A valid session (the prior test reset the in-memory map) plus an explicit lock: guessing the
  // current password via set-password hits the SAME lockout as login (not an unthrottled oracle).
  const s = auth.createSession();
  require('../config').set(db.get(), 'auth', { fail_count: 9, locked_until: Math.floor(Date.now() / 1000) + 999 });
  const r = await call('POST', '/api/auth/set-password', {
    cookie: `${auth.SESSION_COOKIE}=${s.id}`, csrf: s.csrf,
    body: { password: 'another-good-one', current_password: 'a-good-password' },
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'locked');
});

test('csrfOk: false without a session or without the header; true on a constant-time match', () => {
  const s = { csrf: 'a'.repeat(64) };
  assert.equal(auth.csrfOk(null, { headers: { 'x-csrf-token': s.csrf } }), false, 'no session -> false');
  assert.equal(auth.csrfOk(s, { headers: {} }), false, 'no header -> false');
  assert.equal(auth.csrfOk(s, { headers: { 'x-csrf-token': 'b'.repeat(64) } }), false, 'wrong length/value -> false');
  assert.equal(auth.csrfOk(s, { headers: { 'x-csrf-token': s.csrf } }), true, 'exact match -> true');
});

test('cookieHeader adds Secure only when COOKIE_SECURE=1; clearCookieHeader expires the cookie', () => {
  const prev = process.env.COOKIE_SECURE;
  delete process.env.COOKIE_SECURE;
  const plain = auth.cookieHeader('sid123');
  assert.match(plain, /^pickhash_session=sid123; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);
  assert.doesNotMatch(plain, /Secure/);
  process.env.COOKIE_SECURE = '1';
  assert.match(auth.cookieHeader('sid123'), /; Secure$/, 'Secure appended on TLS transports');
  if (prev === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = prev;
  assert.match(auth.clearCookieHeader(), /Max-Age=0/, 'clear expires immediately');
});
