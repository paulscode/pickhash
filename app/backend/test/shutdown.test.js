'use strict';
/*
 * Graceful stop. An update or restart sends SIGTERM mid-tick; closing the database while an
 * MRR create or extend is awaiting its reply leaves a billed purchase unrecorded. Shutdown
 * must wait for held work, start nothing new, and still give up after its bound.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const shutdown = require('../shutdown');
const { createLoop } = require('../engine/loop');
const { execute } = require('../engine/execute');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-shutdown-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => { shutdown._reset(); });

test('drain waits for held work to finish', async () => {
  let release;
  const work = shutdown.hold(() => new Promise((r) => { release = r; }));
  let drained = null;
  const d = shutdown.drain(5000).then((v) => { drained = v; });
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, null, 'still waiting while the work is in flight');
  assert.equal(shutdown.requested(), true);
  release('done');
  assert.equal(await work, 'done');
  await d;
  assert.equal(drained, true);
});

test('drain with nothing in flight resolves at once, and gives up at its bound', async () => {
  assert.equal(await shutdown.drain(10), true);
  shutdown._reset();
  shutdown.hold(() => new Promise(() => {}));   // never finishes
  assert.equal(await shutdown.drain(10), false, 'bounded: a hung call cannot block exit forever');
});

test('the loop starts no tick once shutdown has begun, and the running tick is held', async () => {
  let release;
  let calls = 0;
  const observeFn = () => { calls += 1; return new Promise((r) => { release = () => r({ snapshot: null, nextState: {}, idle: true }); }); };
  const loop = createLoop({ conn: db.get(), client: {}, observeFn, now: () => 1000 });
  const first = loop.tick();
  let drained = null;
  const d = shutdown.drain(5000).then((v) => { drained = v; });
  const second = await loop.tick();
  assert.equal(second.skipped, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, null, 'shutdown waits for the tick in flight');
  release();
  await first;
  await d;
  assert.equal(drained, true);
  // Overlap guard is clear again, but shutdown still refuses a new tick.
  const third = await loop.tick();
  assert.equal(third.stopping, true);
  assert.equal(calls, 1);
});

test('autopilot execute creates nothing once shutdown has begun', async () => {
  await shutdown.drain(10);
  let creates = 0;
  const client = { async put() { creates += 1; return { id: 1 }; } };
  const res = await execute(db.get(), client, {
    sessionId: 1, endpoint: { host: 'a.gg', port: 1, worker_base: 'bc1qx', mrr_profile_id: 7 },
    gateResult: { authorized: [{ rigId: 1, lengthHours: 3, paidSats: 100, feeSats: 3, advertisedTh: 1 }], wouldDo: [] },
  });
  assert.equal(creates, 0);
  assert.equal(res.halted, true);
  assert.equal(res.haltReason, 'shutting_down');
});
