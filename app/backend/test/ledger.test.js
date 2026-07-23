'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../engine/ledger');

const LIMIT = 100;   // must match ledger.js's page size

// A capturing mock: records each get() call's path + params, returns a canned response.
function mockClient(resp) {
  const state = { calls: [] };
  return {
    state,
    async get(path, params) {
      state.calls.push({ path, params });
      return typeof resp === 'function' ? resp(params) : resp;
    },
  };
}
// A paginating mock: serves `total` rows across pages of LIMIT, honoring the `start` offset.
function pagedClient(total, makeRow = (i) => ({ id: i, type: 'Payment' })) {
  const state = { calls: [] };
  return {
    state,
    async get(path, params) {
      state.calls.push({ path, params });
      const start = params.start || 0;
      const slice = [];
      for (let i = start; i < Math.min(start + LIMIT, total); i += 1) slice.push(makeRow(i));
      return { transactions: slice, total: String(total), returned: slice.length, start };
    },
  };
}

// ---- blip-safe guards: every failure mode collapses to [] ----

test('fetchSessionLedger: a null client -> []', async () => {
  assert.deepEqual(await ledger.fetchSessionLedger(null, { started_at: 100 }), []);
});

test('fetchSessionLedger: a null session -> []', async () => {
  assert.deepEqual(await ledger.fetchSessionLedger(pagedClient(5), null), []);
});

test('fetchSessionLedger: a thrown client.get -> []', async () => {
  const client = { async get() { throw new Error('MRR 500'); } };
  assert.deepEqual(await ledger.fetchSessionLedger(client, { started_at: 100 }), []);
});

test('fetchSessionLedger: a missing transactions field -> []', async () => {
  assert.deepEqual(await ledger.fetchSessionLedger(mockClient({}), { started_at: 100 }), []);
});

// ---- pagination: a session larger than one page is fully assembled, not truncated ----

test('fetchSessionLedger: a single short page is returned as-is', async () => {
  const out = await ledger.fetchSessionLedger(pagedClient(37), { started_at: 100 });
  assert.equal(out.length, 37);
});

test('fetchSessionLedger: exactly one full page then a terminating empty page', async () => {
  const client = pagedClient(LIMIT);   // 100 rows -> page 0 full (100), page 1 empty
  const out = await ledger.fetchSessionLedger(client, { started_at: 100 });
  assert.equal(out.length, LIMIT, 'all 100 rows collected (no false truncation)');
  assert.equal(client.state.calls.length, 2, 'fetched a second page to confirm completeness');
  assert.equal(client.state.calls[1].params.start, LIMIT);
});

test('fetchSessionLedger: multiple pages are concatenated across the start offset', async () => {
  const client = pagedClient(250);   // 100 + 100 + 50
  const out = await ledger.fetchSessionLedger(client, { started_at: 100 });
  assert.equal(out.length, 250, 'a 250-row session is fully reconciled, not dropped to []');
  assert.deepEqual(client.state.calls.map((c) => c.params.start), [0, 100, 200]);
});

test('fetchSessionLedger: a row repeated across a page boundary is deduped by id (no double-count)', async () => {
  // Both pages include id 99 (a boundary shift as a new row posts); it must appear once.
  let call = 0;
  const client = {
    state: { calls: [] },
    async get(path, params) {
      this.state.calls.push({ path, params });
      call += 1;
      if (call === 1) return { transactions: Array.from({ length: LIMIT }, (_, i) => ({ id: i, type: 'Payment' })) };
      return { transactions: [{ id: 99, type: 'Payment' }, { id: 100, type: 'Payment' }] };   // 99 repeats
    },
  };
  const out = await ledger.fetchSessionLedger(client, { started_at: 100 });
  assert.equal(out.length, LIMIT + 1, '101 unique rows (id 99 not counted twice)');
  assert.equal(out.filter((t) => t.id === 99).length, 1);
});

test('fetchSessionLedger: an unbounded ledger (never a short page) falls back to [] at the page cap', async () => {
  // Every page is full -> completeness can't be guaranteed -> safe recorded-fallback.
  const client = { async get() { return { transactions: Array.from({ length: LIMIT }, (_, i) => ({ id: Math.random(), type: 'Payment' })) }; } };
  assert.deepEqual(await ledger.fetchSessionLedger(client, { started_at: 100 }), []);
});

// ---- request params ----

test('fetchSessionLedger: passes time_greater_eq = started_at, limit, and a start offset', async () => {
  const client = pagedClient(3);
  await ledger.fetchSessionLedger(client, { started_at: 1_700_000_000 });
  assert.equal(client.state.calls[0].path, '/account/transactions');
  assert.deepEqual(client.state.calls[0].params, { time_greater_eq: 1_700_000_000, limit: LIMIT, start: 0 });
});

test('fetchSessionLedger: time_greater_eq falls back to 0 when started_at is null', async () => {
  const client = pagedClient(3);
  await ledger.fetchSessionLedger(client, { started_at: null });
  assert.equal(client.state.calls[0].params.time_greater_eq, 0);
});
