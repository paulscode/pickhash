'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-pool-'));
process.env.DATA_DIR = DATA;
process.env.POOL_TEST_MIN_INTERVAL_MS = '0';   // no inter-probe spacing in the test's rapid sequence
process.env.DASHBOARD_PASSWORD = 'x';           // managed -> satisfies the password-before-probe gate
const server = require('../server');
const db = require('../db');

let appServer;
let appPort;
let stratumServer;
let stratumPort;

function fakeStratum() {
  return net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method === 'mining.subscribe') {
          sock.write(`${JSON.stringify({ id: m.id, result: [[['mining.notify', '1']], 'e', 4], error: null })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [131072] })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.notify', params: ['job'] })}\n`);
        }
        if (m.method === 'mining.authorize') sock.write(`${JSON.stringify({ id: m.id, result: true, error: null })}\n`);
      }
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, () => r(s.address().port)));
function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: appPort, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) })); });
    r.on('error', reject); r.write(data); r.end();
  });
}

before(async () => {
  db.open(DATA);
  stratumServer = fakeStratum();
  stratumPort = await listen(stratumServer);
  appServer = http.createServer(server.handleRequest);
  appPort = await listen(appServer);
});

after(async () => {
  await new Promise((r) => stratumServer.close(r));
  await new Promise((r) => appServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('pool-test rejects missing/invalid inputs', async () => {
  assert.equal((await post('/api/setup/pool-test', { host: '', port: 0, user: '' })).json.error, 'host_port_user_required');
  assert.equal((await post('/api/setup/pool-test', { host: 'bad host!', port: 123, user: 'u' })).json.error, 'invalid_host_or_port');
  assert.equal((await post('/api/setup/pool-test', { host: '1.2.3.4', port: 123, user: 'bad user!' })).json.error, 'invalid_worker');
});

test('pool-test runs our authoritative probe, flags bare IP, and stores the endpoint + difficulty', async () => {
  const r = await post('/api/setup/pool-test', { host: '127.0.0.1', port: stratumPort, user: 'bc1qaddr.phash' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, 'our probe confirmed work');
  assert.equal(r.json.probe.gotWork, true);
  assert.equal(r.json.probe.difficulty, 131072);
  assert.equal(r.json.bare_ip, true);         // 127.0.0.1 is an IP
  assert.match(r.json.warning, /IP-based pools/);
  assert.equal(r.json.mrr_advisory, null);    // no MRR creds stored in this test

  // The active endpoint (with captured difficulty and parsed worker base) is persisted.
  const row = db.get().prepare('SELECT * FROM pool_endpoints WHERE active = 1').get();
  assert.equal(row.host, '127.0.0.1');
  assert.equal(row.port, stratumPort);
  assert.equal(row.worker_base, 'bc1qaddr.phash');   // full username base (address + worker)
  assert.equal(row.stratum_diff, 131072);
});

test('a failing pool-test does not persist or clobber the working endpoint', async () => {
  // Port 1 is closed -> the probe gets no work; the previously-stored endpoint must survive.
  const r = await post('/api/setup/pool-test', { host: '127.0.0.1', port: 1, user: 'bc1qaddr.w' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  const row = db.get().prepare('SELECT * FROM pool_endpoints WHERE active = 1').get();
  assert.equal(row.port, stratumPort, 'the working endpoint from the prior test is still active');
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM pool_endpoints').get().n, 1, 'no failed endpoint inserted');
});

test('pool-test accepts a pasted full stratum URL with an empty port field', async () => {
  const r = await post('/api/setup/pool-test', { host: `stratum+tcp://127.0.0.1:${stratumPort}`, port: '', user: 'bc1qaddr.w' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, 'the pasted URL parsed to a working host:port');
});
