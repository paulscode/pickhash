'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const stratum = require('../stratum');

// A minimal fake stratum server. mode: 'work' (full handshake + work),
// 'nowork' (subscribe/auth but no notify), 'silent' (accept TCP, never reply).
function fakeStratum(mode = 'work', difficulty = 65536) {
  return net.createServer((sock) => {
    sock.on('error', () => {});
    if (mode === 'silent') return;
    if (mode === 'trickle') {
      // Emit junk regularly but never send work — this resets an idle timer forever.
      const t = setInterval(() => { try { sock.write('x\n'); } catch { clearInterval(t); } }, 40);
      sock.on('close', () => clearInterval(t));
      return;
    }
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method === 'mining.subscribe') {
          sock.write(`${JSON.stringify({ id: m.id, result: [[['mining.set_difficulty', '1'], ['mining.notify', '1']], 'ex1', 4], error: null })}\n`);
          if (mode === 'work') {
            sock.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [difficulty] })}\n`);
            sock.write(`${JSON.stringify({ id: null, method: 'mining.notify', params: ['job'] })}\n`);
          }
        }
        if (m.method === 'mining.authorize') sock.write(`${JSON.stringify({ id: m.id, result: true, error: null })}\n`);
      }
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, () => r(s.address().port)));

test('probe reports a healthy endpoint: subscribed, authorized, work, difficulty', async () => {
  const srv = fakeStratum('work', 65536);
  const port = await listen(srv);
  try {
    const r = await stratum.probe('127.0.0.1', port, 'bc1qaddr.worker', { timeoutMs: 3000 });
    assert.equal(r.reachable, true);
    assert.equal(r.subscribed, true);
    assert.equal(r.authorized, true);
    assert.equal(r.gotWork, true);
    assert.equal(r.difficulty, 65536);
    assert.ok(r.msToFirstWork >= 0);
    assert.equal(r.error, null);
  } finally { srv.close(); }
});

test('probe reports a TCP-reachable but non-serving endpoint (timeout, no work)', async () => {
  const srv = fakeStratum('silent');
  const port = await listen(srv);
  try {
    const r = await stratum.probe('127.0.0.1', port, 'u', { timeoutMs: 300 });
    assert.equal(r.reachable, true);
    assert.equal(r.gotWork, false);
    assert.equal(r.error, 'timeout');
  } finally { srv.close(); }
});

test('probe resolves within the deadline even when the host trickles bytes (no work)', async () => {
  const srv = fakeStratum('trickle');
  const port = await listen(srv);
  try {
    const t0 = Date.now();
    const r = await stratum.probe('127.0.0.1', port, 'u', { timeoutMs: 250 });
    const elapsed = Date.now() - t0;
    assert.equal(r.gotWork, false);
    assert.equal(r.error, 'timeout');
    assert.ok(elapsed < 2000, `resolved in ${elapsed}ms (hard deadline held despite trickle)`);
  } finally { srv.close(); }
});

test('probe reports an unreachable endpoint (connection refused)', async () => {
  const r = await stratum.probe('127.0.0.1', 1, 'u', { timeoutMs: 1000 });
  assert.equal(r.reachable, false);
  assert.equal(r.gotWork, false);
  assert.ok(r.error);
});

// DATUM's real order, captured from a live Gateway: the first job goes out with the
// subscribe reply, before the password is read, and a difficulty asked for in the
// password follows the authorize reply as a fresh set_difficulty and job. The later
// messages are sent in a separate write after a pause, so the test cannot pass by both
// arriving in one read. reportScale imitates a BLAKE2b gateway, which reports 16383.75
// for d=16384. honour=false is a stock gateway that discards the password.
function fakeDatum({ honour = true, reportScale = 1, defaultDiff = 64 } = {}) {
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
          sock.write(`${JSON.stringify({ id: m.id, result: [[], 'ex1', 8], error: null })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [defaultDiff * reportScale] })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.notify', params: ['job1'] })}\n`);
        }
        if (m.method === 'mining.authorize') {
          sock.write(`${JSON.stringify({ id: m.id, result: true, error: null })}\n`);
          const want = /^d=(\d+)$/.exec(m.params[1] || '');
          if (honour && want) {
            setTimeout(() => {
              try {
                sock.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [Number(want[1]) * reportScale] })}\n`);
                sock.write(`${JSON.stringify({ id: null, method: 'mining.notify', params: ['job2'] })}\n`);
              } catch { /* closed */ }
            }, 100);
          }
        }
      }
    });
  });
}

test('awaitAuthDifficulty reports the difficulty set after the password was read', async () => {
  const srv = fakeDatum({ reportScale: 16383.75 / 16384 });
  const port = await listen(srv);
  try {
    const r = await stratum.probe('127.0.0.1', port, 'u', { pass: 'd=256', timeoutMs: 3000, awaitAuthDifficulty: true });
    assert.equal(r.gotWork, true);
    assert.ok(Math.abs(r.difficulty - 256) < 0.1, `got ${r.difficulty}`);
    assert.ok(r.msToFirstWork != null);
  } finally { srv.close(); }
});

test('without awaitAuthDifficulty the probe still stops at the first work, as before', async () => {
  const srv = fakeDatum();
  const port = await listen(srv);
  try {
    const r = await stratum.probe('127.0.0.1', port, 'u', { pass: 'd=256', timeoutMs: 3000 });
    assert.equal(r.gotWork, true);
    assert.equal(r.difficulty, 64, 'the default, sent before the password was read');
  } finally { srv.close(); }
});

test('awaitAuthDifficulty against a gateway that ignores the password settles on the default', async () => {
  const srv = fakeDatum({ honour: false });
  const port = await listen(srv);
  try {
    const t0 = Date.now();
    const r = await stratum.probe('127.0.0.1', port, 'u', { pass: 'd=256', timeoutMs: 5000, awaitAuthDifficulty: true });
    assert.equal(r.gotWork, true);
    assert.equal(r.difficulty, 64);
    assert.equal(r.error, null);
    assert.ok(Date.now() - t0 < 4000, 'the grace period ends it, not the timeout');
  } finally { srv.close(); }
});
