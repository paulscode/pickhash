'use strict';
/*
 * Autopilot may rent a rig that has never been measured, where the algorithm's market
 * makes that the normal case.
 *
 * The rule it relaxes is a deadlock on a young market, not a safety margin: a rig
 * cannot earn a delivery history until somebody rents it, so on BLAKE2b every rig
 * stays unproven and autopilot buys nothing while the marketplace lists rigs. On
 * sha256ab, with thousands of rigs, a proven alternative nearly always exists and the
 * rule is worth keeping.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const quote = require('../quote');
const market = require('../market');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-up-'));
  db.open(dir);
  try { return fn(db.get()); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A rig as the marketplace returns it. `windows` false = never measured. */
function rawRig(id, { windows = true, variance = 0 } = {}) {
  const base = 3_000_000;   // 3 TH expressed in MH, the unit the short windows use
  return {
    id, name: `rig-${id}`, owner: 'o', region: 'us-east', rpi: '96.0',
    status: { status: 'available', rented: false, online: true }, online: true,
    poolstatus: 'online', available_status: 'available',
    optimal_diff: { min: '1000', max: '2000000' }, extensions: true,
    minhours: '3', maxhours: '96',
    price: { type: 'th', BTC: { currency: 'BTC', price: '0.00292545', hour: '0.0001', min_rental_length: 3, enabled: true } },
    hashrate: {
      advertised: { hash: '3', type: 'th' },
      ...(windows ? {
        last_5min: { hash: String(base * (1 - variance)), type: 'mh' },
        last_15min: { hash: String(base), type: 'mh' },
        last_30min: { hash: String(base * (1 + variance)), type: 'mh' },
      } : {}),
    },
  };
}

const norm = (r) => market.normalizeRig(r);
const OPTS = { mode: 'autopilot', minRpi: 90, blacklist: [], stabilityTolerancePct: 20 };
const reasons = (raw, opts) => quote.eligibility(quote.derive(norm(raw), opts), opts).reasons;

test('a never-measured rig is skipped by default and taken when allowed', () => {
  const fresh = rawRig('1', { windows: false });
  assert.ok(reasons(fresh, OPTS).includes('no_stability_data'));
  assert.deepEqual(reasons(fresh, { ...OPTS, allowUnproven: true }), [], 'accepted with the opt-out');
});

test('the opt-out does not excuse a rig that was measured and came back too variable', () => {
  // This is the distinction that matters. Absence of evidence is what gets relaxed;
  // evidence of variability is not, and it has its own threshold already.
  const jumpy = rawRig('2', { variance: 0.5 });
  assert.ok(reasons(jumpy, OPTS).includes('unstable'));
  assert.ok(reasons(jumpy, { ...OPTS, allowUnproven: true }).includes('unstable'),
    'still skipped: it has a history, and the history is bad');
});

test('nor does it excuse anything else that would disqualify a rig', () => {
  const offline = rawRig('3', { windows: false });
  offline.poolstatus = 'offline';
  const r = reasons(offline, { ...OPTS, allowUnproven: true });
  assert.ok(r.includes('pool_offline'));
  assert.ok(!r.includes('no_stability_data'));
});

test('it is off for sha256ab and on for blake2b, without anyone setting it', () => {
  withDb((conn) => {
    assert.equal(config.getKey(conn, 'strategy', 'allow_unproven_rigs'), false, 'a deep market keeps the rule');
    config.set(conn, 'algorithm', { active: 'blake2b' });
    assert.equal(config.getKey(conn, 'strategy', 'allow_unproven_rigs'), true, 'a young one relaxes it');
  });
});

test('a user can override it either way, per algorithm', () => {
  withDb((conn) => {
    config.set(conn, 'algorithm', { active: 'blake2b' });
    config.set(conn, 'strategy', { allow_unproven_rigs: false });
    assert.equal(config.getKey(conn, 'strategy', 'allow_unproven_rigs'), false);
    // And the other algorithm is untouched by that, as with every scoped setting.
    config.set(conn, 'algorithm', { active: 'sha256ab' });
    assert.equal(config.getKey(conn, 'strategy', 'allow_unproven_rigs'), false);
    config.set(conn, 'strategy', { allow_unproven_rigs: true });
    assert.equal(config.getKey(conn, 'strategy', 'allow_unproven_rigs'), true);
    config.set(conn, 'algorithm', { active: 'blake2b' });
    assert.equal(config.getKey(conn, 'strategy', 'allow_unproven_rigs'), false, "blake2b keeps its own");
  });
});

test('every path that filters rigs passes the setting through', () => {
  /*
   * The setting is worthless if the preview honours it and the loop that actually
   * spends does not, or the reverse: the estimate would promise rigs the live loop
   * then refuses. Checked by shape, because a new caller is the way that breaks.
   */
  const dir = path.join(__dirname, '..');
  const files = ['session.js', 'quote-service.js', 'engine/autopilot.js', 'engine/decide.js'];
  const missing = files.filter((f) => !fs.readFileSync(path.join(dir, f), 'utf8').includes('allowUnproven'));
  assert.deepEqual(missing, [], `these build rig-eligibility options but never pass allowUnproven: ${missing.join(', ')}`);
});
