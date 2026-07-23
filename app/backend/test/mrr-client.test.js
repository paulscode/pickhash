'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const {
  MrrClient, memoryNonceStore, dbNonceStore, sign, signablePath, toQuery,
  MrrAmbiguousError, MrrHttpError, MrrNonceError, MrrAuthError, MrrApiError,
} = require('../mrr-client');

// A Response-like stub for the injected fetch.
function res(status, obj) {
  return { status, text: async () => (obj === undefined ? '' : JSON.stringify(obj)) };
}
function ok(data) { return res(200, { success: true, data }); }

function client(fetchImpl, extra = {}) {
  return new MrrClient({
    key: 'TESTKEY', secret: 'TESTSECRET', nonceStore: memoryNonceStore(),
    fetch: fetchImpl, throttleMs: 0, backoffBaseMs: 1, ...extra,
  });
}

test('signing matches the pinned vector', () => {
  // HMAC-SHA1(TESTSECRET, "TESTKEY" + "1000" + "/whoami")
  assert.equal(sign('TESTSECRET', 'TESTKEY', 1000, '/whoami'),
    'a44d97f934c04f9b33649f68988d6a0d34408832');
});

test('signable path strips query string and trailing slash, never the api prefix', () => {
  assert.equal(signablePath('/rig/14?type=sha256ab'), '/rig/14');
  assert.equal(signablePath('/account/pool/'), '/account/pool');
  assert.equal(signablePath('/whoami'), '/whoami');
});

test('toQuery flattens nested params to dotted keys and skips null/undefined', () => {
  assert.equal(toQuery({ type: 'sha256ab', hash: { min: 5 } }), 'type=sha256ab&hash.min=5');
  assert.equal(toQuery({ a: 1, b: null, c: undefined, d: 2 }), 'a=1&d=2');
  assert.equal(toQuery({ 'region.type': 'include', x: 'a b' }), 'region.type=include&x=a%20b');
  assert.equal(toQuery({}), '');
});

test('GET appends the query with & when the endpoint already has one', async () => {
  let captured;
  const c = client(async (url) => { captured = url; return ok({}); });
  await c.get('/rig?x=1', { type: 'sha256ab' });
  assert.match(captured, /\/rig\?x=1&type=sha256ab$/);
});

test('dbNonceStore persists a strictly increasing nonce across reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-nonce-'));
  try {
    db.open(dir);
    const store = dbNonceStore(db.get());
    assert.equal(store.read(), 0);                 // singleton row seeded at 0
    store.write(1000);
    assert.equal(store.read(), 1000);
    db.close();
    // Reopen (simulated restart): the persisted value survives.
    db.open(dir);
    const store2 = dbNonceStore(db.get());
    assert.equal(store2.read(), 1000);
    // A client backed by it never goes backwards.
    const c = new MrrClient({ key: 'K', secret: 'S', nonceStore: store2, fetch: async () => ok({}) });
    const n = c.nextNonce();
    assert.ok(n > 1000);
    assert.equal(store2.read(), n);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET signs the bare path and sends the nonce/sign headers', async () => {
  let captured;
  const c = client(async (url, opts) => { captured = { url, headers: opts.headers }; return ok({ userid: 1 }); });
  const data = await c.get('/rig', { type: 'sha256ab' });
  assert.deepEqual(data, { userid: 1 });
  assert.match(captured.url, /\/api\/v2\/rig\?type=sha256ab$/);
  assert.equal(captured.headers['x-api-key'], 'TESTKEY');
  assert.ok(captured.headers['x-api-nonce']);
  // Signature is over the bare path "/rig", not the query.
  assert.equal(captured.headers['x-api-sign'],
    sign('TESTSECRET', 'TESTKEY', captured.headers['x-api-nonce'], '/rig'));
});

test('nonce strictly increases and persists across a restart', () => {
  const store = memoryNonceStore();
  const a = new MrrClient({ key: 'K', secret: 'S', nonceStore: store, fetch: async () => ok({}) });
  const n1 = a.nextNonce();
  const n2 = a.nextNonce();
  assert.ok(n2 > n1);
  // "Restart": a new client sharing the persisted store must not go backwards.
  const b = new MrrClient({ key: 'K', secret: 'S', nonceStore: store, fetch: async () => ok({}) });
  const n3 = b.nextNonce();
  assert.ok(n3 > n2);
});

test('calls are serialized and use strictly increasing nonces', async () => {
  const nonces = [];
  const c = client(async (_url, opts) => { nonces.push(Number(opts.headers['x-api-nonce'])); return ok({}); });
  await Promise.all([c.get('/a'), c.get('/b'), c.get('/c')]);
  assert.equal(nonces.length, 3);
  assert.ok(nonces[0] < nonces[1] && nonces[1] < nonces[2], 'nonces strictly increase');
});

test('a mutation that times out throws MrrAmbiguousError and is NOT retried', async () => {
  let calls = 0;
  const c = client(async () => { calls++; throw new Error('aborted'); });
  await assert.rejects(() => c.put('/rental', { rig: 1, length: 3, profile: 9 }), MrrAmbiguousError);
  assert.equal(calls, 1, 'exactly one HTTP attempt — never double-rent');
});

test('a mutation 5xx throws MrrAmbiguousError and is NOT retried', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return res(503, { success: false, data: { message: 'busy' } }); });
  await assert.rejects(() => c.put('/rental', {}), MrrAmbiguousError);
  assert.equal(calls, 1);
});

test('reads retry transient 5xx up to 3 attempts then throw', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return res(500, {}); });
  await assert.rejects(() => c.get('/whoami'), MrrHttpError);
  assert.equal(calls, 3);
});

test('reads recover after a transient failure', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return calls < 2 ? res(500, {}) : ok({ userid: 7 }); });
  const data = await c.get('/whoami');
  assert.deepEqual(data, { userid: 7 });
  assert.equal(calls, 2);
});

test('a read nonce rejection resyncs and retries once', async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return calls < 2 ? res(200, { success: false, data: { message: 'invalid nonce' } }) : ok({ ok: 1 });
  });
  const data = await c.get('/whoami');
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls, 2);
});

test('auth failures map to MrrAuthError', async () => {
  const c = client(async () => res(200, { success: false, data: { message: 'permission denied' } }));
  await assert.rejects(() => c.get('/whoami'), MrrAuthError);
});

test('a mutation nonce rejection is surfaced, not retried', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return res(200, { success: false, data: { message: 'bad nonce' } }); });
  await assert.rejects(() => c.put('/rental', {}), MrrNonceError);
  assert.equal(calls, 1);
});

// A raw (non-JSON-envelope) response, e.g. an HTML error page from a proxy/WAF.
function rawRes(status, text) { return { status, text: async () => text }; }

test('a 4xx with a non-JSON body throws, never returns null-as-success', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return rawRes(403, '<html>Forbidden</html>'); });
  await assert.rejects(() => c.put('/rental', { rig: 1 }), MrrAuthError);
  assert.equal(calls, 1, 'a rejected mutation is one attempt, not retried');
});

test('a 400 surfaces as an API error (not silently null, not retried)', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return rawRes(400, 'bad request'); });
  await assert.rejects(() => c.get('/whoami'), MrrApiError);
  assert.equal(calls, 1);
});

test('a body that stalls after headers aborts on timeout (ambiguous for a mutation)', async () => {
  // Server sends headers, then never completes the body read.
  const c = client(async (_url, opts) => ({
    status: 200,
    text: () => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  }), { timeoutMs: 100 });
  await assert.rejects(() => c.put('/rental', {}), MrrAmbiguousError);
});

test('a 2xx with an unparseable body is ambiguous for a mutation, an error for a read', async () => {
  const cm = client(async () => rawRes(200, '<html>oops not json</html>'));
  await assert.rejects(() => cm.put('/rental', {}), MrrAmbiguousError);
  const cr = client(async () => rawRes(200, '<html>oops not json</html>'));
  await assert.rejects(() => cr.get('/whoami'), MrrHttpError);
});

test('an enveloped "invalid api key" maps to an auth error (suspend signal)', async () => {
  const c = client(async () => res(200, { success: false, data: { message: 'Invalid API key' } }));
  await assert.rejects(() => c.get('/whoami'), MrrAuthError);
});

test('nonce resync never moves the stored nonce backwards', () => {
  const { memoryNonceStore } = require('../mrr-client');
  const store = memoryNonceStore();
  const c = new MrrClient({ key: 'K', secret: 'S', nonceStore: store, fetch: async () => ok({}), throttleMs: 0 });
  // Burst several nonces in the same tick so the stored value climbs above Date.now().
  const issued = [c.nextNonce(), c.nextNonce(), c.nextNonce(), c.nextNonce()];
  const high = store.read();
  assert.equal(high, issued[issued.length - 1]);
  // Simulate the resync write the client performs on a nonce rejection.
  store.write(Math.max(store.read(), Date.now()));
  assert.ok(store.read() >= high, 'resync did not regress below already-issued nonces');
});
