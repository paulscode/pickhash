'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { createLoop, buildTickMetrics, persistTick } = require('../engine/loop');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-loop-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => { db.get().prepare('DELETE FROM tick_metrics').run(); });

const snapOk = {
  ts: 0, fetch_ok: { rentals: true }, session: { id: 1, target_th: 3000, spent_sats: 1408 },
  rentals: [{ delivered_th: 200, ended: false }], balance: { confirmed_sats: 47000, unconfirmed_sats: 0 },
  endpoint: { ok: true }, market: { lowest: 0.0005, last10: 0.0006 }, hashgg: { reachable: true },
};

test('buildTickMetrics aggregates a snapshot; a null snapshot is an all-not-ok row', () => {
  const m = buildTickMetrics(snapOk, 5000);
  assert.equal(m.ts, 5);
  assert.equal(m.delivered_th, 200);
  assert.equal(m.target_th, 3000);
  assert.equal(m.mrr_ok, 1);
  assert.equal(m.endpoint_ok, 1);
  const z = buildTickMetrics(null, 6000);
  assert.equal(z.mrr_ok, 0);
  assert.equal(z.endpoint_ok, 0);
  assert.equal(z.session_id, null);
});

test('the loop skips an overlapping tick instead of queueing it', async () => {
  let calls = 0;
  let release;
  const slow = () => { calls += 1; return new Promise((r) => { release = () => r({ snapshot: { ...snapOk }, nextState: {} }); }); };
  const loop = createLoop({ conn: db.get(), client: {}, observeFn: slow, now: () => 1000 });

  const p1 = loop.tick();               // starts, parks in observeFn
  const r2 = await loop.tick();         // running -> skipped
  assert.equal(r2.skipped, true);
  assert.equal(calls, 1, 'the second tick did not invoke observe');
  release();
  await p1;
  assert.equal(loop.running, false);
});

test('a throwing observe still writes a tick_metrics row with error flags', async () => {
  const loop = createLoop({
    conn: db.get(), client: {}, now: () => 2000,
    observeFn: async () => { throw new Error('mrr unreachable'); },
  });
  const r = await loop.tick();
  assert.equal(r.error.message, 'mrr unreachable');
  const row = db.get().prepare('SELECT * FROM tick_metrics WHERE ts = 2').get();
  assert.ok(row, 'a row was still written');
  assert.equal(row.mrr_ok, 0);
  assert.equal(row.endpoint_ok, 0);
});

test('an idle tick short-circuits: writes NO tick_metrics row, returns {skipped:false, idle:true}', async () => {
  const loop = createLoop({
    conn: db.get(), client: {}, now: () => 7000,
    observeFn: async () => ({ snapshot: null, nextState: null, idle: true }),
  });
  const r = await loop.tick();
  assert.deepEqual(r, { skipped: false, idle: true });
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM tick_metrics').get().n, 0,
    'no junk row before setup');
});

// A full (non-null) snapshot: a session, a MIX of ended and active rentals (one with a
// null delivered_th), a balance, and a market. Every persisted column is pinned below.
const snapFull = {
  ts: 0, fetch_ok: { rentals: true },
  session: { id: 42, target_th: 5000, spent_sats: 9000 },
  rentals: [
    { delivered_th: 100, ended: false },
    { delivered_th: 250, ended: false },
    { delivered_th: 50, ended: true },     // ended -> excluded from active, still summed
    { delivered_th: null, ended: false },  // null delivered -> summed as 0
  ],
  balance: { confirmed_sats: 47000, unconfirmed_sats: 1200 },
  endpoint: { ok: true }, market: { lowest: 0.0005, last10: 0.0006 }, hashgg: { reachable: true },
};

test('persistTick round-trips every column of a full snapshot', () => {
  const m = persistTick(db.get(), snapFull, 8000);
  const row = db.get().prepare('SELECT * FROM tick_metrics WHERE ts = 8').get();
  assert.ok(row, 'a row was written');
  assert.equal(row.session_id, 42);
  assert.equal(row.delivered_th, 400);        // 100+250+50+0 (null summed as 0)
  assert.equal(row.active_rentals, 3);        // only the non-ended rentals
  assert.equal(row.target_th, 5000);
  assert.equal(row.spent_sats, 9000);
  assert.equal(row.balance_confirmed_sats, 47000);
  assert.equal(row.balance_unconfirmed_sats, 1200);
  assert.equal(row.market_lowest, 0.0005);
  assert.equal(row.market_last10, 0.0006);
  assert.equal(row.endpoint_ok, 1);
  assert.equal(row.mrr_ok, 1);
  assert.equal(row.hashgg_ok, 1);
  // The returned metrics mirror the row.
  assert.equal(m.delivered_th, 400);
  assert.equal(m.active_rentals, 3);
});

test('a non-null snapshot with a null session: session_id/target_th/spent_sats zeroed, rentals still summed', () => {
  const m = buildTickMetrics({ ...snapFull, session: null }, 9000);
  assert.equal(m.session_id, null);
  assert.equal(m.target_th, 0);
  assert.equal(m.spent_sats, 0);
  assert.equal(m.delivered_th, 400, 'rentals are still summed without a session');
  assert.equal(m.active_rentals, 3);
});

test('prevState propagates: a returned nextState feeds the next tick; a null nextState holds the prior state', async () => {
  const seen = [];
  let step = 0;
  const observeFn = async (_conn, _client, ctx) => {
    seen.push(ctx.prevState);
    step += 1;
    if (step === 1) return { snapshot: { ...snapOk }, nextState: { tag: 'A' } };
    if (step === 2) return { snapshot: { ...snapOk }, nextState: null };   // null -> hold prior
    return { snapshot: { ...snapOk }, nextState: { tag: 'B' } };
  };
  const loop = createLoop({
    conn: db.get(), client: {}, now: () => 1000, observeFn,
    initialState: { tag: 'init' },
  });
  await loop.tick();   // sees init -> returns A
  await loop.tick();   // sees A -> returns null -> holds A
  await loop.tick();   // sees A again (held)
  assert.deepEqual(seen[0], { tag: 'init' }, 'first tick sees initialState');
  assert.deepEqual(seen[1], { tag: 'A' }, 'nextState A fed forward');
  assert.deepEqual(seen[2], { tag: 'A' }, 'a null nextState held the prior state');
});

test('start() runs an immediate first tick', async () => {
  let calls = 0;
  const loop = createLoop({
    conn: db.get(), client: {}, intervalMs: 1e9, now: () => 3000,
    observeFn: async () => { calls += 1; return { snapshot: { ...snapOk }, nextState: {} }; },
  });
  loop.start();
  await new Promise((r) => setTimeout(r, 20));   // let the immediate tick settle
  loop.stop();
  assert.equal(calls, 1, 'first tick fired immediately, not after the interval');
});
