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
  db.get().prepare('DELETE FROM rentals').run();
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
  config.set(db.get(), 'guardrails', { blended_ceiling_sats_unit_day: 6000, blended_ceiling_auto: false, rate_ceiling_sats_th_hour: 500 });
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

  // Any failed read clears the reading at once: a feed that says its data is bad (an error status,
  // no ceiling in the body) stops spending now, not at the max age.
  for (const [opts, re] of [
    [{ status: 503, body: 'down' }, /HTTP 503/],
    [{ body: 'not json' }, /not JSON/],
    [{ body: { as_of: NOW } }, /blended/],
    [{ error: Object.assign(new Error('x'), { name: 'TimeoutError' }) }, /timed out/],
    [{ body: 'x', headers: { 'content-length': String(1024 * 1024) } }, /too large/],
    [{ error: Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) }, /ECONNREFUSED/],
  ]) {
    await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW } }) });
    assert.equal(cs.effective(db.get(), NOW).halted, false, 'good again before each case');
    const st = await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch(opts) });
    assert.match(st.error, re);
    const now = cs.effective(db.get(), NOW);
    assert.deepEqual([now.halted, now.blendedSatsUnitDay, now.rateSatsThHour], [true, 0, 0], `fails closed at once: ${re}`);
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

test('any stored blended ceiling caps the feed, and the status says when it does', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6630, as_of: NOW } }) });
  let e = cs.effective(db.get(), NOW);
  assert.equal(e.blendedSatsUnitDay, 6630);
  assert.deepEqual([e.source.cappedBlended, e.source.noUpperLimit], [false, true]);
  // Even one first saved as a preview suggestion: the number Settings shows is the one that holds.
  config.set(db.get(), 'guardrails', { blended_ceiling_sats_unit_day: 5500, blended_ceiling_auto: true });
  e = cs.effective(db.get(), NOW);
  assert.equal(e.blendedSatsUnitDay, 5500);
  assert.deepEqual([e.source.cappedBlended, e.source.noUpperLimit, e.source.blended], [true, false, 6630]);
});

test('a feed of 0 is reported as zero, not as fresh and fine', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 0, as_of: NOW } }) });
  const e = cs.effective(db.get(), NOW);
  assert.deepEqual([e.halted, e.source.ok, e.source.zero], [true, true, true]);
});

test('parseBody: hex strings are refused; a slightly-future as_of counts as now', () => {
  assert.equal(cs.parseBody({ blended_ceiling_sats_unit_day: '0x1F', as_of: NOW }, NOW).ok, false);
  assert.equal(cs.parseBody({ blended_ceiling_sats_unit_day: 5, as_of: NOW + 120 }, NOW).asOf, NOW);
});

test('settings: a feed URL with a username or password is refused', () => {
  assert.equal(config.validatePatch('guardrails', { ceiling_source_url: 'http://u:p@10.0.0.5/c.json' }).ok, false);
});

// The body limit against a real server, since the stand-in fetch above has no stream.
function serve(handler) {
  const http = require('http');
  return new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve(srv)); });
}
test('the body limit holds for a chunked reply with no length, and for a gzip bomb', async () => {
  const zlib = require('zlib');
  const chunked = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });   // no content-length: chunked
    const piece = Buffer.alloc(16 * 1024, 0x20);
    let n = 0;
    const pump = () => { while (n < 4096) { n++; if (!res.write(piece)) { res.once('drain', pump); return; } } res.end(); };
    pump();
  });
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
  const gz = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': bomb.length });
    res.end(bomb);
  });
  try {
    for (const srv of [chunked, gz]) {
      config.set(db.get(), 'guardrails', { ceiling_source_url: `http://127.0.0.1:${srv.address().port}/c.json` });
      const st = await cs.refresh(db.get(), { nowSec: NOW });
      assert.match(st.error, /too large/);
      assert.equal(cs.effective(db.get(), NOW).halted, true);
    }
  } finally {
    chunked.closeAllConnections(); gz.closeAllConnections();
    await new Promise((r) => chunked.close(r)); await new Promise((r) => gz.close(r));
  }
});

test('a fresh feed below the stored ceilings is what decide and the gate use', async () => {
  const autopilot = require('../engine/autopilot');
  // Three 100 TH rigs at 0.0002 BTC/hr: 480,000 sats/PH·day, 200 sats/TH/hr. The feed allows less.
  const rawRig = (id) => {
    const mh = String(0.1 * 1e9);
    return { id: String(id), name: `r${id}`, owner: `o${id}`, type: 'sha256ab', status: { status: 'available', rented: false, online: true }, online: true,
      poolstatus: 'online', region: 'us', rpi: '95.00', optimal_diff: { min: '1000', max: '2000000' }, extensions: true,
      price: { type: 'ph', BTC: { currency: 'BTC', price: '0.00480000', hour: '0.0002', min_rental_length: 3, enabled: true } },
      minhours: '3', maxhours: '96', available_status: 'available',
      hashrate: { advertised: { hash: '0.1', type: 'ph' }, last_5min: { hash: mh, type: 'mh' }, last_15min: { hash: mh, type: 'mh' }, last_30min: { hash: mh, type: 'mh' } } };
  };
  const rigs = [rawRig(1), rawRig(2), rawRig(3)];
  const client = { async get(p, params) {
    if (p === '/rig') return (params && params.offset > 0) ? { records: [], total: 3 } : { records: rigs, total: 3, offset: 0, count: 3 };
    throw new Error('unexpected ' + p);
  } };
  db.get().prepare(`INSERT INTO sessions (algo, mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at, time_cap_hours)
    VALUES ('sha256ab', 'autopilot', 'active', 300, 10000000, 0, 0, ?, ?, 168)`).run(NOW, NOW);
  db.get().prepare('DELETE FROM pool_endpoints').run();
  db.get().prepare("INSERT INTO pool_endpoints (host, port, worker_base, mrr_profile_id, active) VALUES ('h', 1, 'w', 5, 1)").run();
  const snap = { fetch_ok: { rentals: true }, rentals: [] };
  const run = () => autopilot.runCycle(db.get(), client, snap, { now: NOW * 1000 });

  // No feed: the market fills (dry-run, so nothing is really rented).
  let r = await run();
  assert.ok(r.plan && r.plan.actions.length > 0, 'fills without a feed');
  // A blended feed below every rig's price: nothing planned, and the ceiling is named.
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 100_000, as_of: NOW } }) });
  r = await run();
  assert.equal(r.plan.actions.length, 0);
  assert.ok(r.plan.notes.includes('blend_ceiling'), r.plan.notes.join(','));
  // A per-rig feed below every rig (100 < 200 sats/TH/hr): nothing planned either.
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 9_000_000, rate_ceiling_sats_th_hour: 100, as_of: NOW } }) });
  r = await run();
  assert.equal(r.plan.actions.length, 0, 'the feed\'s per-rig ceiling reaches decide');
});

test('auto-extend stops on a fresh feed of 0', async () => {
  const extend = require('../engine/extend');
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  config.set(db.get(), 'strategy', { auto_extend: true });
  db.get().prepare(`INSERT INTO sessions (algo, mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at)
    VALUES ('sha256ab', 'autopilot', 'active', 100, 100000, 0, 0, ?, ?)`).run(NOW, NOW);
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 0, as_of: NOW } }) });
  const x = await extend.runAutoExtend(db.get(), {}, { endpoint: { ok: true } }, { now: NOW * 1000 });
  assert.deepEqual([x.ran, x.reason], [false, 'ceiling_zero']);
});

test('ceiling_source_stale arms, fires after 3 minutes, says why, and resolves', async () => {
  const { ceilingSourceTick } = require('../engine/runner');
  db.get().prepare('DELETE FROM alerts').run();
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  db.get().prepare(`INSERT INTO sessions (algo, mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at)
    VALUES ('sha256ab', 'autopilot', 'active', 100, 100000, 0, 0, ?, ?)`).run(NOW, NOW);
  const down = fakeFetch({ status: 503, body: 'x' });
  const alert = () => db.get().prepare("SELECT state, context_json FROM alerts WHERE kind = 'ceiling_source_stale' ORDER BY id DESC LIMIT 1").get();
  await ceilingSourceTick(db.get(), NOW * 1000, () => {}, { fetchImpl: down });
  assert.equal(alert().state, 'armed');
  await ceilingSourceTick(db.get(), (NOW + 200) * 1000, () => {}, { fetchImpl: down });
  assert.equal(alert().state, 'fired');
  assert.match(JSON.parse(alert().context_json).error, /HTTP 503/);
  // A feed of 0 keeps it fired, and the context says so.
  await ceilingSourceTick(db.get(), (NOW + 260) * 1000, () => {}, { fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 0, as_of: NOW + 260 } }) });
  assert.equal(JSON.parse(alert().context_json).zero, true);
  // Good again: resolved.
  await ceilingSourceTick(db.get(), (NOW + 320) * 1000, () => {}, { fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW + 320 } }) });
  assert.equal(alert().state, 'resolved');
  // An alert left on another algorithm is cleared.
  db.get().prepare("INSERT INTO alerts (kind, key, state, severity, armed_at, fired_at, context_json) VALUES ('ceiling_source_stale', 'blake2b', 'fired', 'warning', ?, ?, '{}')").run(NOW, NOW);
  await ceilingSourceTick(db.get(), (NOW + 380) * 1000, () => {}, { fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW + 380 } }) });
  assert.equal(db.get().prepare("SELECT state FROM alerts WHERE kind = 'ceiling_source_stale' AND key = 'blake2b'").get().state, 'resolved');
});

test('settings: plain http is only for a feed on your own network', () => {
  for (const ok of ['http://10.0.0.5/c.json', 'http://192.168.1.20:8080/c', 'http://localhost/c', 'http://127.0.0.1/c',
    'http://feedbox/c', 'http://feedbox.local/c', 'http://myfeed.startos/c', 'http://[::1]/c', 'https://example.com/c']) {
    assert.equal(config.validatePatch('guardrails', { ceiling_source_url: ok }).ok, true, ok);
  }
  for (const bad of ['http://example.com/c', 'http://8.8.8.8/c', 'http://172.32.0.1/c']) {
    assert.equal(config.validatePatch('guardrails', { ceiling_source_url: bad }).ok, false, bad);
  }
  assert.equal(config.validatePatch('guardrails', { ceiling_source_max_age_s: 120 }).ok, false, 'max age at least 3 ticks');
});

test('a feed that names another algorithm or unit fails closed; a BOM is fine', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_ });
  let st = await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW, algo: 'blake2b' } }) });
  assert.match(st.error, /not sha256ab/);
  assert.equal(cs.effective(db.get(), NOW).halted, true);
  st = await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW, price_unit: 'th' } }) });
  assert.match(st.error, /not per ph/);
  st = await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW, algo: 'sha256ab', price_unit: 'PH' } }) });
  assert.equal(st.error, null);
  st = await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: '\uFEFF' + JSON.stringify({ blended_ceiling_sats_unit_day: 6000, as_of: NOW }) }) });
  assert.equal(st.error, null);
});

test('the feed URL shown in status and alerts has no query string', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: 'http://10.0.0.5/c.json?token=s3cret' });
  const e = cs.effective(db.get(), NOW);
  assert.equal(e.source.url, 'http://10.0.0.5/c.json?…');
});

test('auto-extend\'s blend leaves out a rental about to end, as decide() does', () => {
  const { sessionBlend } = require('../engine/extend');
  const sid = Number(db.get().prepare(`INSERT INTO sessions (algo, mode, state, target_th, budget_sats, spent_sats, fee_sats, created_at, started_at)
    VALUES ('sha256ab', 'autopilot', 'active', 100, 100000, 0, 0, ?, ?)`).run(NOW, NOW).lastInsertRowid);
  const ins = db.get().prepare('INSERT INTO rentals (session_id, mrr_id, rig_id, advertised_th, rate_btc_th_day, end_ts, ended) VALUES (?, ?, ?, ?, ?, ?, 0)');
  ins.run(sid, 9001, 'a', 10, 4000e-8, NOW + 240);    // cheap, ending inside a 5-minute window
  ins.run(sid, 9002, 'b', 5, 8000e-8, NOW + 1500);    // dear, the one up for renewal
  assert.ok(Math.abs(sessionBlend(db.get(), sid, NOW, 300) - 8000e-8) < 1e-15, 'only the rental that stays counts');
  assert.ok(sessionBlend(db.get(), sid, NOW, 0) < 8000e-8, 'without a window, both count, as before');
});

test('a 0 from your own Settings is told apart from a feed that says 0', async () => {
  config.set(db.get(), 'guardrails', { ceiling_source_url: URL_, blended_ceiling_sats_unit_day: 0 });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 6000, as_of: NOW } }) });
  let e = cs.effective(db.get(), NOW);
  assert.deepEqual([e.halted, e.source.zero, e.source.zeroFromSettings], [true, true, true]);
  config.set(db.get(), 'guardrails', { blended_ceiling_sats_unit_day: null });
  await cs.refresh(db.get(), { nowSec: NOW, fetchImpl: fakeFetch({ body: { blended_ceiling_sats_unit_day: 0, as_of: NOW } }) });
  e = cs.effective(db.get(), NOW);
  assert.deepEqual([e.source.zero, e.source.zeroFromSettings], [true, false]);
});
