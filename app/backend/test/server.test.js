'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Point the server at a temp frontend dir before requiring it (the path is read at load).
const FRONT = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-front-'));
fs.writeFileSync(path.join(FRONT, 'index.html'), '<!doctype html><title>Pickhash</title>');
fs.writeFileSync(path.join(FRONT, 'app.js'), 'console.log(1);');
fs.writeFileSync(path.join(FRONT, 'style.css'), 'body{color:red}');
// A secret file OUTSIDE the frontend dir, to prove traversal can't reach it.
fs.writeFileSync(path.join(FRONT, '..', 'pickhash-secret.txt'), 'TOPSECRET');
process.env.FRONTEND_DIR = FRONT;
const server = require('../server');
const db = require('../db');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-srv-'));

let httpServer;
let base;
let port;

// Send a raw request path (http.request does NOT normalize the path the way fetch does).
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  db.open(DATA);   // /api routes need an open DB
  httpServer = http.createServer(server.handleRequest);
  port = await new Promise((r) => httpServer.listen(0, () => r(httpServer.address().port)));
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
  db.close();
  fs.rmSync(FRONT, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('/livez is always 200', async () => {
  const r = await fetch(base + '/livez');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('/ready is 503 until the DB is opened (start() not called here)', async () => {
  const r = await fetch(base + '/ready');
  assert.equal(r.status, 503);
});

test('security headers are on every response', async () => {
  const r = await fetch(base + '/livez');
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('serves the static index at /', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Pickhash/);
});

test('the /api surface is gated by setup (412 before completion)', async () => {
  const r = await fetch(base + '/api/status');
  assert.equal(r.status, 412);
  assert.equal((await r.json()).needs_setup, true);
});

test('malformed JSON body on an /api POST is a clean 400', async () => {
  const r = await fetch(base + '/api/setup/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  assert.equal(r.status, 400);
});

test('SPA fallback serves index for an extensionless client route', async () => {
  const r = await fetch(base + '/styleguide');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Pickhash/);
});

test('a missing file WITH an extension 404s (no SPA fallback for assets)', async () => {
  const r = await fetch(base + '/missing.png');
  assert.equal(r.status, 404);
});

test('static files are served with the right MIME type', async () => {
  const js = await fetch(base + '/app.js');
  assert.match(js.headers.get('content-type') || '', /application\/javascript/);
  const css = await fetch(base + '/style.css');
  assert.match(css.headers.get('content-type') || '', /text\/css/);
});

test('directory traversal cannot escape the frontend dir', async () => {
  // A raw ../ path (not normalized away by the client) must not return the secret file.
  for (const p of ['/../pickhash-secret.txt', '/../../pickhash-secret.txt', '/..%2fpickhash-secret.txt']) {
    const r = await rawGet(p);
    assert.notEqual(r.status, 200, `traversal ${p} must not succeed`);
    assert.doesNotMatch(r.body, /TOPSECRET/, `traversal ${p} must not leak the secret`);
  }
});
