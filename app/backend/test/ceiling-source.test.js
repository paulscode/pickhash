'use strict';
/*
 * The ceiling feed (issue #16): a URL that sets the price ceilings, failing closed.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const cs = require('../ceiling-source');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-ceilsrc-'));
const NOW = 1_800_000_000;
const URL_ = 'http://10.0.0.5:8080/ceiling.json';

// A fetch stand-in: replies with `body` (object -> JSON) and `status`, or throws `error`.
function fakeFetch({ body, status = 200, error, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (error) throw error;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  db.get().prepare('DELETE FROM config').run();
  db.get().prepare('DELETE FROM sessions').run();
  cs._reset();
});

test('parseBody: needs a blended ceiling and as_of; rate is optional; refuses junk', () => {
  assert.deepEqual(cs.parseBody({ blended_ceiling_sats_unit_day: 6630.4, rate_ceiling_sats_th_hour: 276.27, as_of: NOW }, NOW),
    { ok: true, blended: 6630.4, rate: 276.27, asOf: NOW });
  assert.equal(cs.parseBody({ blended_ceiling_sats_unit_day: 0, as_of: NOW }, NOW).ok, true, '0 is a valid ceiling');
  assert.equal(cs.parseBody({ blended_ceiling_sats_unit_day: '6630', as_of: String(NOW) }, NOW).ok, true, 'numeric strings are fine');
  for (const bad of [null, [], 'x', {}, { as_of: NOW }, { blended_ceiling_sats_unit_day: -1, as_of: NOW },
    { blended_ceiling_sats_unit_day: 'abc', as_of: NOW }, { blended_ceiling_sats_unit_day: 5 },
    { blended_ceiling_sats_unit_day: 5, as_of: NOW, rate_ceiling_sats_th_hour: -2 }]) {
    assert.equal(cs.parseBody(bad, NOW).ok, false, JSON.stringify(bad));
  }
  assert.match(cs.parseBody({ blended_ceiling_sats_unit_day: 5, as_of: NOW * 1000 }, NOW).error, /milliseconds/);
  assert.match(cs.parseBody({ blended_ceiling_sats_unit_day: 5, as_of: NOW + 3600 }, NOW).error, /future/);
});

test('no feed set: the stored ceilings are in force', async () => {
  config.set(db.get(), 'guardrails', { blended_ceiling_sats_unit_day: 7000, rate_ceiling_sats_th_hour: 300 });
  assert.equal(await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch() }), null);
  const e = cs.effective(db.get(), NOW);
  assert.deepEqual([e.blendedSatsUnitDay, e.rateSatsThHour, e.halted, e.source], [7000, 300, false, null]);
});

test('a fresh feed sets the ceilings; the stored ones stay upper limits', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  const f = fakeFetch({ body: { blended_ceiling_sats_unit_day: 6630.4, rate_ceiling_sats_th_hour: 276.27, as_of: NOW - 30 } });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: f });
  assert.equal(f.calls[0].url, URL_);
  let e = cs.effective(db.get(), NOW);
  assert.equal(e.halted, false);
  assert.equal(e.blendedSatsUnitDay, 6630.4);
  assert.equal(e.rateSatsThHour, 276.27);
  assert.equal(e.source.ok, true);
  assert.equal(e.source.ageS, 30);
  // A stored ceiling below the feed's caps it: the feed can tighten, never loosen.
  config.set(db.get(), 'guardrails', { blended_ceiling_sats_unit_day: 6000, rate_ceiling_sats_th_hour: 500 });
  e = cs.effective(db.get(), NOW);
  assert.equal(e.blendedSatsUnitDay, 6000);
  assert.equal(e.rateSatsThHour, 276.27);
});

test('without a rate in the feed, the stored per-rig ceiling stays', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_, rate_ceiling_sats_th_hour: 400 });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 5000, as_of: NOW } }) });
  assert.equal(cs.effective(db.get(), NOW).rateSatsThHour, 400);
});

test('fails closed: not read yet, stale, or every kind of bad reply', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_, ceiling_source_max_age_s: 600, blended_ceiling_sats_unit_day: 9000 });
  let e = cs.effective(db.get(), NOW);
  assert.deepEqual([e.blendedSatsUnitDay, e.rateSatsThHour, e.halted, e.source.ok], [0, 0, true, false], 'nothing read yet');
  assert.equal(e.source.error, 'not read yet');

  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW - 100 } }) });
  assert.equal(cs.effective(db.get(), NOW).halted, false);
  // The same reading, later than the max age: stale, so 0.
  e = cs.effective(db.get(), NOW + 600);
  assert.equal(e.halted, true);
  assert.equal(e.blendedSatsUnitDay, 0);
  assert.equal(e.source.error, 'stale');

  // A failing refresh keeps the last good reading (still fresh here) and records the error.
  for (const [opts, re] of [
    [{ status: 503, body: 'down' }, /HTTP 503/],
    [{ body: 'not json' }, /not JSON/],
    [{ body: { as_of: NOW } }, /blended/],
    [{ error: Object.assign(new Error('x'), { name: 'TimeoutError' }) }, /timed out/],
    [{ body: 'x', headers: { 'content-length': String(1024 * 1024) } }, /too large/],
  ]) {
    const st = await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch(opts) });
    assert.match(st.error, re);
    const now = cs.effective(db.get(), NOW);
    assert.equal(now.halted, false, 'the last good reading still holds while fresh');
    assert.match(now.source.error, re);
  }
});

test('a feed ceiling of 0 halts, as a stored 0 does', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 0, as_of: NOW } }) });
  assert.equal(cs.effective(db.get(), NOW).halted, true);
  config.set(db.get(), 'guardrails', { ceiling_source_url: null, blended_ceiling_sats_unit_day: 0 });
  assert.equal(cs.effective(db.get(), NOW).halted, true);
});

test('readings are per algorithm and per URL', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW } }) });
  assert.equal(cs.effective(db.get(), NOW).halted, false);
  config.set(db.get(), 'guardrails', { ceiling_source_url: 'http://10.0.0.5:8080/other.json' });
  assert.equal(cs.effective(db.get(), NOW).halted, true, 'a new URL starts unread');
  config.set(db.get(), 'algorithm', { active: 'blake2b' });
  assert.equal(cs.effective(db.get(), NOW).source, null, 'guardrails are per algorithm: none set for blake2b');
});

test('settings: the feed URL must be http(s); blank clears it', () => {
  assert.deepEqual(config.validatePatch('guardrails', { ceiling_source_url: ' https://x.example/c.json ' }).patch, { ceiling_source_url: 'https://x.example/c.json' });
  assert.deepEqual(config.validatePatch('guardrails', { ceiling_source_url: '' }).patch, { ceiling_source_url: null });
  for (const bad of ['file:///etc/passwd', 'not a url', 'javascript:alert(1)', 'x'.repeat(600)]) {
    assert.equal(config.validatePatch('guardrails', { ceiling_source_url: bad }).ok, false, bad);
  }
  assert.equal(config.validatePatch('guardrails', { ceiling_source_max_age_s: 30 }).ok, false, 'max age has a floor');
});

test('autopilot and auto-extend open no spend while the feed is stale', async () => {
  const autopilot = require('../engine/autopilot');
  const extend = require('../engine/extend');
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  config.set(db.get(), 'strategy', { auto_extend: true });
  db.get().prepare(`INSERT INTO sessions (algo, mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at)
    VALUES ('sha256ab', 'autopilot', 'active', 100, 100000, 0, 0, ?, ?)`).run(NOW, NOW);
  db.get().prepare("INSERT OR REPLACE INTO pool_endpoints (host, port, worker_base, mrr_profile_id, active) VALUES ('h', 1, 'w', 5, 1)").run();
  const client = { get: async () => { throw new Error('must not reach the market'); } };
  const r = await autopilot.runCycle(db.get(), client, { fetch_ok: { rentals: true }, rentals: [] }, { now: NOW * 1000 });
  assert.deepEqual([r.ran, r.reason], [false, 'ceiling_source_stale']);
  const x = await extend.runAutoExtend(db.get(), client, { endpoint: { ok: true } }, { now: NOW * 1000 });
  assert.deepEqual([x.ran, x.reason], [false, 'ceiling_source_stale']);
});
