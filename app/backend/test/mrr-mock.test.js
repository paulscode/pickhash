'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer } = require('../../../scripts/mrr-mock');
const { MrrClient, memoryNonceStore, MrrAmbiguousError, MrrApiError } = require('../mrr-client');

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}
function clientFor(port, extra = {}) {
  return new MrrClient({
    key: 'K', secret: 'S', nonceStore: memoryNonceStore(),
    baseUrl: `http://127.0.0.1:${port}`, throttleMs: 0, backoffBaseMs: 1, ...extra,
  });
}

test('mock replays fixtures through a real client round-trip', async () => {
  const server = createMockServer();
  const port = await listen(server);
  try {
    const c = clientFor(port);
    const who = await c.get('/whoami');
    assert.equal(who.permissions.rent, 'yes');
    const algo = await c.get('/info/algos/sha256ab');
    assert.equal(algo.suggested_price.unit, 'ph*day');   // the corrected native unit
    const page = await c.get('/rig', { type: 'sha256ab' });
    assert.ok(Array.isArray(page.records) && page.records.length >= 1);
    const bal = await c.get('/account/balance');
    assert.equal(bal.BTC.confirmed, '0.00050000');
  } finally {
    await close(server);
  }
});

test('mock ambiguous scenario: a mutation hang produces MrrAmbiguousError, no retry', async () => {
  let hits = 0;
  const server = createMockServer({
    scenario: ({ method, path }) => {
      if (method !== 'GET' && path === '/rental') { hits++; return { hang: true }; }
      return null;
    },
  });
  const port = await listen(server);
  try {
    const c = clientFor(port, { timeoutMs: 200 });
    await assert.rejects(() => c.put('/rental', { rig: 1, length: 3, profile: 9 }), MrrAmbiguousError);
    assert.equal(hits, 1, 'the mutation was attempted exactly once');
  } finally {
    await close(server);
  }
});

test('mock serves each fixture-backed route with the expected shape', async () => {
  const server = createMockServer();
  const port = await listen(server);
  try {
    const c = clientFor(port);
    assert.equal((await c.get('/account/balance')).BTC.confirmed, '0.00050000');
    assert.ok(Array.isArray((await c.get('/account/transactions')).transactions));
    assert.equal((await c.get('/rig/800003')).id, '800003');           // single-rig detail from the search fixture
    assert.equal((await c.get('/rental/9000001')).id, '9000001');
    assert.equal((await c.put('/account/pool', { name: 'x' })).id, '7000001');
    assert.equal((await c.put('/account/profile', { name: 'x' })).id, '7000002');
    assert.equal((await c.put('/account/profile/7000002/0', { poolid: 1 })).success, true);
    assert.equal((await c.put('/rental/9000001/pool/0', {})).success, true);
    assert.ok(Array.isArray(await c.put('/rental/9000001/message', { message: 'hi' })));
    assert.ok(Array.isArray(await c.put('/rental/9000001/extend', { length: 1, getcost: 1 })));
    // An unknown route yields a {success:false} envelope -> MrrApiError.
    await assert.rejects(() => c.get('/no/such/route'), MrrApiError);
  } finally {
    await close(server);
  }
});

test('mock paginates GET /rig by offset/count', async () => {
  const server = createMockServer();
  const port = await listen(server);
  try {
    const c = clientFor(port);
    const p0 = await c.get('/rig', { count: 1, offset: 0 });
    assert.equal(p0.records.length, 1);
    assert.equal(p0.count, 1);
    const p2 = await c.get('/rig', { count: 100, offset: 2 });
    assert.equal(p2.records.length, 0);   // past the end -> empty page (lets fetchAllRigs terminate)
  } finally {
    await close(server);
  }
});

test('mock rig-taken scenario surfaces an API error to the caller', async () => {
  const server = createMockServer({
    scenario: ({ method, path }) =>
      (method === 'PUT' && path === '/rental')
        ? { status: 200, json: { success: false, data: { message: 'rig no longer available' } } }
        : null,
  });
  const port = await listen(server);
  try {
    const c = clientFor(port);
    await assert.rejects(() => c.put('/rental', {}), MrrApiError);
  } finally {
    await close(server);
  }
});
