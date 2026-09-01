'use strict';
/*
 * Configuration is per-algorithm where it describes how to spend money, and shared
 * where it does not.
 *
 * The failure this guards against is quiet: a spend ceiling tuned against one market
 * silently governing the other, three orders of magnitude away. Nothing throws, and a
 * guardrail that never triggers looks exactly like a guardrail that is working, so
 * the only way to catch it is to assert the separation directly.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const algos = require('../algos');
const market = require('../market');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-algo-'));
  try { db.open(dir); fn(db.get()); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function switchTo(conn, slug) {
  config.set(conn, 'algorithm', { active: slug });
}

test('a fresh database is on the default algorithm', () => {
  withDb((conn) => {
    assert.equal(config.activeAlgo(conn), 'sha256ab');
    assert.equal(market.activeAlgo(conn), 'sha256ab');
  });
});

test('a guardrail set for one algorithm does not govern the other', () => {
  withDb((conn) => {
    config.set(conn, 'guardrails', { max_daily_spend_sats: 777 });
    assert.equal(config.getKey(conn, 'guardrails', 'max_daily_spend_sats'), 777);

    switchTo(conn, 'blake2b');
    assert.notEqual(
      config.getKey(conn, 'guardrails', 'max_daily_spend_sats'), 777,
      "sha256ab's ceiling must not follow the user onto blake2b",
    );

    // And back: the original override is still there, not overwritten by the switch.
    switchTo(conn, 'sha256ab');
    assert.equal(config.getKey(conn, 'guardrails', 'max_daily_spend_sats'), 777);
  });
});

test('each algorithm gets its own defaults, not the base ones', () => {
  withDb((conn) => {
    const base = config.getKey(conn, 'guardrails', 'max_session_budget_sats');
    assert.equal(base, config.DEFAULTS.guardrails.max_session_budget_sats);

    switchTo(conn, 'blake2b');
    assert.equal(
      config.getKey(conn, 'guardrails', 'max_session_budget_sats'),
      algos.defaultsFor('blake2b', 'guardrails').max_session_budget_sats,
    );
    assert.notEqual(config.getKey(conn, 'guardrails', 'max_session_budget_sats'), base);
  });
});

test('a stored override still beats the algorithm default', () => {
  withDb((conn) => {
    switchTo(conn, 'blake2b');
    config.set(conn, 'guardrails', { max_session_budget_sats: 12345 });
    assert.equal(config.getKey(conn, 'guardrails', 'max_session_budget_sats'), 12345);
  });
});

test('global namespaces are shared, so a switch cannot lose a DuckDNS setup', () => {
  withDb((conn) => {
    config.set(conn, 'duckdns', { enabled: true, subdomain: 'mine' });
    switchTo(conn, 'blake2b');
    const d = config.get(conn, 'duckdns');
    assert.equal(d.enabled, true);
    assert.equal(d.subdomain, 'mine');
  });
});

test('one algorithm\'s config is readable while another is active', () => {
  withDb((conn) => {
    config.set(conn, 'guardrails', { max_daily_spend_sats: 111 }, 'sha256ab');
    config.set(conn, 'guardrails', { max_daily_spend_sats: 222 }, 'blake2b');
    // Still on sha256ab, but the settings page has to be able to show either.
    assert.equal(config.getKey(conn, 'guardrails', 'max_daily_spend_sats', 'blake2b'), 222);
    assert.equal(config.getKey(conn, 'guardrails', 'max_daily_spend_sats'), 111);
  });
});

test('an unrecognised stored algorithm falls back rather than throwing', () => {
  withDb((conn) => {
    // A hand-edited or downgraded database must not be able to stop the app: this is
    // on the path of every read and every write.
    config.set(conn, 'algorithm', { active: 'scrypt-from-the-future' });
    assert.equal(config.activeAlgo(conn), algos.DEFAULT_ALGO);
    assert.doesNotThrow(() => config.get(conn, 'guardrails'));
  });
});

test('the algorithm namespace is not writable through the settings API', () => {
  // Switching algorithms changes which market is being bought from and which
  // guardrails apply. It needs its own path with its own checks, not a generic
  // key/value POST that happens to accept it.
  assert.equal(config.validatePatch('algorithm', { active: 'blake2b' }).ok, false);
});

test('fetchAllRigs refuses an algorithm it does not know', async () => {
  // The alternative is fetching /rig with a bogus type and treating whatever comes
  // back as the market, which is how a typo turns into a rental.
  await assert.rejects(() => market.fetchAllRigs({}, 'nonsense'), /unknown algorithm/);
});

test('every migration on disk is recorded as applied, in the same transaction', () => {
  withDb((conn) => {
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const recorded = conn.prepare('SELECT filename FROM schema_migrations ORDER BY filename')
      .all().map((r) => r.filename);
    assert.deepEqual(recorded, files);

    // The record is written inside the applying transaction, not after it. Recorded
    // afterwards, a crash in between would leave the effect without the record and the
    // next boot would re-run a completed migration; 009 and 010 rebuild tables by
    // re-deriving the algorithm from the old rows, so a second run flattens the very
    // dimension the first one populated.
    const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
    const applyBlock = src.slice(src.indexOf("database.exec('BEGIN')"), src.indexOf("catch (err)"));
    assert.match(applyBlock, /record\(\)/, 'the migration is recorded before COMMIT');
    assert.ok(
      applyBlock.indexOf('record()') < applyBlock.indexOf("exec('COMMIT')"),
      'the record must come before the commit, not after it',
    );
  });
});
