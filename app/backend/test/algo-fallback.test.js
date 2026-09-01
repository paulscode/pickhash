'use strict';
/*
 * The fallback pool cannot send hashrate to a pool that will not mine it.
 *
 * `bip110.mine.ocean.xyz` is a SHA256 pool, and both settings that route rented
 * hashrate to it defaulted to on. Under blake2b that combination fails over to a pool
 * that cannot accept the work: the rental keeps billing and produces nothing, and it
 * engages at the moment the user's endpoint has already failed, so nobody is looking
 * at the right screen. Nothing errors, and the help text said the hashrate was being
 * saved rather than wasted.
 *
 * The guard is structural rather than a check: callers pass a resolved pool object
 * instead of a boolean, so there is no way to say "fallback enabled" and have it mean
 * Ocean on an algorithm Ocean cannot serve. These assert that from the outside.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const algos = require('../algos');
const session = require('../session');
const deadRig = require('../engine/dead-rig-fallback');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-fb-'));
  try { db.open(dir); return fn(db.get()); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const OCEAN_HOST = 'bip110.mine.ocean.xyz';

function recordingClient() {
  const puts = [];
  return {
    puts,
    async put(p, body) { puts.push([p, body]); return /\/rental$/.test(p) ? { id: 9001 } : { ok: true }; },
    async get() { return {}; },
  };
}

test('sha256ab resolves to Ocean when the user has the safety net on', () => {
  withDb((conn) => {
    const pool = session.resolveFallbackPool(conn);
    assert.equal(pool.host, OCEAN_HOST);
    assert.equal(pool.name, 'Ocean');
  });
});

test('blake2b resolves to no fallback pool, however the setting is left', () => {
  withDb((conn) => {
    config.set(conn, 'algorithm', { active: 'blake2b' });
    assert.equal(session.resolveFallbackPool(conn), null, 'off by default');

    // And forced on, which is what a user who switched algorithms after tuning
    // sha256ab would have stored, or anyone editing the database directly.
    config.set(conn, 'strategy', { fallback_pool_enabled: true });
    assert.equal(config.getKey(conn, 'strategy', 'fallback_pool_enabled'), true, 'the setting is on');
    assert.equal(session.resolveFallbackPool(conn), null, 'and it still resolves to no pool');
  });
});

test('a blake2b rental attaches no second pool, even with the setting forced on', async () => {
  await withDb(async (conn) => {
    config.set(conn, 'algorithm', { active: 'blake2b' });
    config.set(conn, 'strategy', { fallback_pool_enabled: true });
    const client = recordingClient();
    const intent = { rigId: 42, lengthHours: 3, advertisedTh: 4, priceUnit: 'th', rateCapUnitDay: 0.00129 };
    const endpoint = { host: 'ab.example.gg', port: 26596, worker_base: 'bc1qabc.phash', mrr_profile_id: 1 };
    const res = await session.rentOne(client, intent, endpoint, { fallbackPool: session.resolveFallbackPool(conn) });
    assert.equal(res.fallback, 'off');
    assert.equal(client.puts.filter((c) => /\/pool\/1$/.test(c[0])).length, 0, 'no priority-1 pool attached');
    assert.ok(!JSON.stringify(client.puts).includes(OCEAN_HOST), 'Ocean is nowhere on the wire');
  });
});

test('dead-rig reroute refuses when the algorithm has no fallback pool', async () => {
  await withDb(async (conn) => {
    config.set(conn, 'algorithm', { active: 'blake2b' });
    config.set(conn, 'strategy', { dead_rig_reroute_enabled: true, fallback_pool_enabled: true });
    const client = recordingClient();
    const r = await deadRig.maybeReroute(conn, client, { rentals: [] }, { now: Date.now() });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'no_fallback_pool');
    assert.equal(client.puts.length, 0, 'nothing was sent at all');
  });
});

test('the settings page marks both switches unavailable, with a reason', () => {
  withDb((conn) => {
    const sha = config.settings(conn).strategy;
    assert.ok(!sha.fallback_pool_enabled.unavailable);
    assert.equal(sha.fallback_pool_enabled.label, 'Fallback pool (Ocean)');

    config.set(conn, 'algorithm', { active: 'blake2b' });
    const b2 = config.settings(conn).strategy;
    for (const key of ['fallback_pool_enabled', 'dead_rig_reroute_enabled']) {
      assert.equal(b2[key].unavailable, true, key);
      // A reason, not just a greyed-out box. The setting is on by default for the
      // other algorithm, so a user who knows that deserves to be told why.
      assert.match(b2[key].help, /BLAKE2b/, key);
      assert.match(b2[key].help, /[Uu]navailable for this algorithm/, key);
    }
    // Ocean must not be named at a user who cannot use it.
    assert.ok(!b2.fallback_pool_enabled.label.includes('Ocean'));
  });
});

test('the registry is the only place a fallback pool is named', () => {
  // The host used to be a constant in session.js that every path reached for. If it
  // comes back, this fails: an algorithm without an entry would inherit it silently.
  const dir = path.join(__dirname, '..');
  const files = [];
  for (const d of [dir, path.join(dir, 'engine')]) {
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) files.push(path.join(d, f));
  }
  const offenders = files
    .filter((f) => path.basename(f) !== 'algos.js')
    .filter((f) => fs.readFileSync(f, 'utf8').includes(OCEAN_HOST))
    .map((f) => path.relative(dir, f));
  assert.deepEqual(offenders, [], `only algos.js may name a pool host, found in: ${offenders.join(', ')}`);
});

test('every algorithm either has a usable fallback pool or none at all', () => {
  for (const slug of algos.SLUGS) {
    const pool = algos.fallbackPool(slug);
    if (pool === null) continue;
    assert.ok(pool.host && pool.port && pool.name, `${slug} fallback pool is fully specified`);
  }
});

test('the server refuses to store a setting the active algorithm cannot use', async () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const dbx = require('../db'); const { handleApi } = require('../api');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'pickhash-un-'));
  dbx.open(dir);
  try {
    const conn = dbx.get();
    config.set(conn, 'setup', { completed: true });
    config.set(conn, 'algorithm', { active: 'blake2b' });
    const out = { status: 0, json: null };
    const res = {
      writeHead(s) { out.status = s; }, setHeader() {},
      end(payload) { try { out.json = JSON.parse(payload); } catch { out.json = payload; } },
    };
    await handleApi(
      { method: 'POST', headers: {}, url: '/api/config' }, res,
      new URL('/api/config', 'http://x'),
      { ns: 'strategy', patch: { fallback_pool_enabled: true } }, { dataDir: dir },
    );
    // Stored, it would sit there looking set and mean nothing, which is the same shape
    // as a guardrail that never fires.
    assert.equal(out.status, 409);
    assert.equal(out.json.error, 'unavailable_for_algorithm');
    assert.equal(out.json.field, 'fallback_pool_enabled');
    assert.equal(config.getKey(conn, 'strategy', 'fallback_pool_enabled'), false, 'unchanged');

    // A setting the algorithm CAN use still saves.
    out.status = 0;
    await handleApi(
      { method: 'POST', headers: {}, url: '/api/config' }, res,
      new URL('/api/config', 'http://x'),
      { ns: 'strategy', patch: { min_rpi: 77 } }, { dataDir: dir },
    );
    assert.equal(out.status, 200);
    assert.equal(config.getKey(conn, 'strategy', 'min_rpi'), 77);
  } finally { dbx.close(); fsx.rmSync(dir, { recursive: true, force: true }); }
});
