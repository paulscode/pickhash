'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-cfg-'));
  try { db.open(dir); fn(db.get()); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('returns defaults for an untouched namespace', () => {
  withDb((conn) => {
    const s = config.get(conn, 'strategy');
    assert.equal(s.min_rpi, 90);
    assert.equal(s.health_debounce_minutes, 10);
    assert.equal(s.fallback_pool_enabled, true);   // Ocean safety-net on by default
  });
});

test('the canonical knob list includes the spend guardrails', () => {
  withDb((conn) => {
    const g = config.get(conn, 'guardrails');
    for (const k of ['max_session_budget_sats', 'max_daily_spend_sats', 'refund_watch_days', 'deposit_leadtime_hours']) {
      assert.ok(k in g, `guardrail ${k} present`);
    }
    assert.deepEqual(Object.keys(config.all(conn)).sort(), ['algorithm', 'duckdns', 'guardrails', 'notifications', 'strategy', 'ui']);
  });
});

test('set stores only overrides; defaults still merge on read', () => {
  withDb((conn) => {
    config.set(conn, 'strategy', { min_rpi: 95 });
    const eff = config.get(conn, 'strategy');
    assert.equal(eff.min_rpi, 95);                  // the override
    assert.equal(eff.health_debounce_minutes, 10);  // untouched default still present
    // The stored row holds ONLY the override, so a future default change would propagate.
    const raw = JSON.parse(conn.prepare('SELECT json FROM config WHERE ns = ?').get('strategy').json);
    assert.deepEqual(raw, { min_rpi: 95 });
  });
});

test('ships the auto-extend / rate-ceiling defaults (pinned so a silent change is caught)', () => {
  withDb((conn) => {
    // Optional hard price ceiling defaults OFF (null), not 0 (which would gate everything).
    assert.equal(config.getKey(conn, 'guardrails', 'rate_ceiling_sats_th_hour'), null);
    const s = config.get(conn, 'strategy');
    assert.equal(s.auto_extend, false, 'auto-extend is opt-in');
    assert.equal(s.auto_extend_price_tolerance_pct, 10);
  });
});

test('getKey reads a single effective value, before and after override', () => {
  withDb((conn) => {
    assert.equal(config.getKey(conn, 'guardrails', 'refund_watch_days'), 14);
    config.set(conn, 'guardrails', { refund_watch_days: 7 });
    assert.equal(config.getKey(conn, 'guardrails', 'refund_watch_days'), 7);
  });
});

test('validatePatch coerces + bounds-checks and rejects unknown keys / non-settings namespaces', () => {
  const v = config.validatePatch('strategy', { min_rpi: '85', auto_extend: 'true', region_include: 'us, eu' });
  assert.deepEqual(v, { ok: true, patch: { min_rpi: 85, auto_extend: true, region_include: ['us', 'eu'] } });
  // bounds + type
  assert.equal(config.validatePatch('strategy', { min_rpi: 200 }).ok, false, 'over max');
  assert.equal(config.validatePatch('strategy', { replace_lead_minutes: -1 }).ok, false, 'under min');
  assert.equal(config.validatePatch('strategy', { min_rpi: 1.5 }).reason, 'expected a whole number');
  // enum
  assert.equal(config.validatePatch('ui', { hashrate_unit: 'gh' }).ok, false);
  assert.deepEqual(config.validatePatch('ui', { hashrate_unit: 'th' }).patch, { hashrate_unit: 'th' });
  // floatOrNull: blank clears the rate ceiling, a number is kept
  assert.deepEqual(config.validatePatch('guardrails', { rate_ceiling_sats_th_hour: '' }).patch, { rate_ceiling_sats_th_hour: null });
  assert.deepEqual(config.validatePatch('guardrails', { rate_ceiling_sats_th_hour: '2.5' }).patch, { rate_ceiling_sats_th_hour: 2.5 });
  // unknown key / namespace rejected (defense against writing arbitrary config)
  assert.equal(config.validatePatch('strategy', { nope: 1 }).field, 'nope');
  assert.equal(config.validatePatch('secrets', { x: 1 }).ok, false, 'a non-SETTINGS namespace is not writable');
  assert.equal(config.validatePatch('run', { mode: 'live' }).ok, false, 'run mode is not settable via the config API');
});

test('validatePatch rejects inherited prototype keys (__proto__/constructor) as unknown settings', () => {
  assert.equal(config.validatePatch('strategy', JSON.parse('{"__proto__": 5}')).ok, false, '__proto__ own-key rejected');
  assert.equal(config.validatePatch('strategy', { constructor: 5 }).field, 'constructor', 'constructor rejected');
  assert.equal(config.validatePatch('guardrails', { toString: 1 }).ok, false, 'toString rejected');
});

test('a stored null never masks a non-null default (a corrupt config cannot null out a spend ceiling)', () => {
  withDb((conn) => {
    // Simulate a corrupt/direct null for a guardrail that ships with a real default.
    config.set(conn, 'guardrails', { max_daily_spend_sats: null });
    assert.equal(JSON.parse(conn.prepare('SELECT json FROM config WHERE ns = ?').get('guardrails').json).max_daily_spend_sats, null, 'the null is actually stored');
    assert.equal(config.getKey(conn, 'guardrails', 'max_daily_spend_sats'), 10000000, 'read falls back to the shipped default, not null/no-cap');
    // A key whose default IS intentionally null still resolves to null.
    assert.equal(config.getKey(conn, 'guardrails', 'rate_ceiling_sats_th_hour'), null);
  });
});
