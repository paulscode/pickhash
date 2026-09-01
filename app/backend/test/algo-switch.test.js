'use strict';
/*
 * Switching algorithms is its own action, with its own checks.
 *
 * It is not a knob among knobs: it changes which market is bought from, which
 * guardrails apply, which endpoint is live and which marketplace account objects are
 * used. The dangerous moment is doing it while money is in flight, because the
 * running loop would go on maintaining a target it can no longer buy for, and the
 * rentals already paid for on the other market would go unmanaged.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const market = require('../market');
const algos = require('../algos');
const { handleApi } = require('../api');

// Async body, so the close has to wait for it. Returning the promise from a sync
// try/finally closes the database out from under the test.
async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-sw-'));
  db.open(dir);
  try { return await fn(db.get(), dir); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Drive one API route and capture what it sent. */
async function call(dataDir, method, p, body) {
  const out = { status: 0, json: null };
  const res = {
    writeHead(status) { out.status = status; },
    setHeader() {},
    end(payload) { try { out.json = JSON.parse(payload); } catch { out.json = payload; } },
  };
  await handleApi({ method, headers: {}, url: p }, res, new URL(p, 'http://x'), body || {}, { dataDir });
  return out;
}

test('the switch changes the active algorithm and reports the new one', async () => {
  await withDb(async (conn, dir) => {
    assert.equal(market.activeAlgo(conn), 'sha256ab');
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 200);
    assert.equal(r.json.algorithm.slug, 'blake2b');
    assert.equal(r.json.algorithm.price_unit, 'th');
    assert.equal(market.activeAlgo(conn), 'blake2b');
  });
});

test('an unknown algorithm is refused', async () => {
  await withDb(async (conn, dir) => {
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'scrypt' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'unknown_algorithm');
    assert.equal(market.activeAlgo(conn), 'sha256ab', 'unchanged');
  });
});

test('the switch is refused while a session is live, and changes nothing', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare(
      `INSERT INTO sessions (algo, mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('sha256ab', 'autopilot', 'active', 100, 500000, 24, 0, 0, 1, 1)`,
    ).run();
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'session_active');
    assert.equal(market.activeAlgo(conn), 'sha256ab', 'the setting did not move');
  });
});

test('a winding-down session blocks it too', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare(
      `INSERT INTO sessions (algo, mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('sha256ab', 'autopilot', 'winding_down', 100, 500000, 24, 0, 0, 1, 1)`,
    ).run();
    // Rentals bought on the other market are still running and still being managed.
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 409);
  });
});

test('an ended session does not block it', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare(
      `INSERT INTO sessions (algo, mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('sha256ab', 'autopilot', 'ended', 100, 500000, 24, 0, 0, 1, 1)`,
    ).run();
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 200);
  });
});

test('the switch is recorded, stamped with the algorithm it moved to', async () => {
  await withDb(async (conn, dir) => {
    await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    const d = conn.prepare("SELECT algo, note FROM decisions WHERE note LIKE 'algorithm switched%'").get();
    assert.ok(d, 'the switch left a record');
    assert.equal(d.algo, 'blake2b');
    assert.match(d.note, /from sha256ab to blake2b/);
  });
});

test('switching to the algorithm already active is a no-op, not an error', async () => {
  await withDb(async (conn, dir) => {
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'sha256ab' });
    assert.equal(r.status, 200);
    assert.equal(conn.prepare("SELECT COUNT(*) n FROM decisions WHERE note LIKE 'algorithm switched%'").get().n, 0);
  });
});

test('the switch works before setup completes, so the endpoint is saved under the right one', async () => {
  await withDb(async (conn, dir) => {
    // The saved endpoint belongs to an algorithm. Choosing after saving one is exactly
    // the mismatch this work exists to prevent, so the route sits above the setup gate.
    assert.equal(config.getKey(conn, 'setup', 'completed'), undefined, 'setup is not complete');
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 200);
    assert.equal(market.activeAlgo(conn), 'blake2b');
    // And the rest of the API is still closed, so lifting it did not open a hole.
    assert.equal((await call(dir, 'GET', '/api/status')).status, 412);
  });
});

test('status and config both describe the algorithm the same way', async () => {
  await withDb(async (conn, dir) => {
    config.set(conn, 'setup', { completed: true });
    await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    const status = await call(dir, 'GET', '/api/status');
    const cfg = await call(dir, 'GET', '/api/config');
    // The header reads one and the settings card reads the other. If they could
    // disagree, the badge whose whole job is to be trusted at a glance would be the
    // thing that was wrong.
    assert.deepEqual(status.json.algorithm, cfg.json.algorithm);
    assert.equal(status.json.algorithm.slug, 'blake2b');
    assert.deepEqual(cfg.json.algorithm.choices.map((c) => c.slug), algos.SLUGS);
  });
});
