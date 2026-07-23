'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const hashgg = require('../hashgg');

function fakeHashgg(routes) {
  return http.createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}
const listen = (s) => new Promise((r) => s.listen(0, () => r(s.address().port)));

test('discovers a playit endpoint (DNS name, not flagged as IP)', async () => {
  const srv = fakeHashgg({
    '/api/tunnel/mode': { mode: 'playit' },
    '/api/status': { public_endpoint: 'example-tunnel.example.com:26596' },
  });
  const port = await listen(srv);
  try {
    const r = await hashgg.probe('127.0.0.1', port);
    assert.equal(r.reachable, true);
    assert.equal(r.mode, 'playit');
    assert.deepEqual(r.publicEndpoint, { host: 'example-tunnel.example.com', port: 26596, isIp: false });
  } finally { srv.close(); }
});

test('discovers a vps endpoint (bare IP flagged)', async () => {
  const srv = fakeHashgg({
    '/api/tunnel/mode': { mode: 'vps' },
    '/api/vps/status': { public_endpoint: '85.203.40.167:23335' },
  });
  const port = await listen(srv);
  try {
    const r = await hashgg.probe('127.0.0.1', port);
    assert.equal(r.mode, 'vps');
    assert.deepEqual(r.publicEndpoint, { host: '85.203.40.167', port: 23335, isIp: true });
  } finally { srv.close(); }
});

test('returns reachable:false when HashGG is not running (never throws)', async () => {
  const r = await hashgg.probe('127.0.0.1', 1, { timeoutMs: 800 });
  assert.equal(r.reachable, false);
  assert.equal(r.publicEndpoint, null);
});

test('returns reachable:false for an empty host', async () => {
  assert.deepEqual(await hashgg.probe('', 3000), { reachable: false, mode: null, publicEndpoint: null, raw: null });
});

test('parseEndpoint handles the stratum+tcp prefix and rejects garbage', () => {
  assert.deepEqual(hashgg.parseEndpoint('stratum+tcp://host.example:1234'), { host: 'host.example', port: 1234, isIp: false });
  assert.deepEqual(hashgg.parseEndpoint('10.0.0.5:3333'), { host: '10.0.0.5', port: 3333, isIp: true });
  assert.equal(hashgg.parseEndpoint('nonsense'), null);
  assert.equal(hashgg.parseEndpoint(''), null);
});
