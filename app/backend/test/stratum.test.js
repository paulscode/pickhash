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
