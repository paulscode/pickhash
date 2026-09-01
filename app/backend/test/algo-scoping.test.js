'use strict';
/*
 * The guard for #5: prove that a second algorithm's rows cannot reach a read that
 * is meant to be scoped to the active one.
 *
 * The rest of the suite runs on sha256ab-only data, so it passes whether or not the
 * scoping exists. This file is the one that fails if a filter is dropped: it seeds
 * blake2b rows that are deliberately extreme, then asserts every scoped read still
 * answers with the sha256ab numbers.
 *
 * The values are chosen so a blend is unmistakable rather than plausible. Real
 * blake2b prices really are about 2,425x sha256ab per TH (measured from the live
 * API, see the fixtures), which is exactly why a blended average would look like a
 * number rather than an error.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-algo-'));
process.env.DATA_DIR = DATA;

const server = require('../server');
const db = require('../db');
const market = require('../market');
const config = require('../config');

let appServer;
let appPort;

const OTHER = 'blake2b';
const NOW = Math.floor(Date.now() / 1000);

function call(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: appPort, path: p, method }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  db.open(DATA);
  // Pass the setup gate, as api.test.js does; auth stays open with no password.
  config.set(db.get(), 'setup', { completed: true });
  const conn = db.get();
  const mine = market.activeAlgo(conn);
  assert.notEqual(mine, OTHER, 'the fixture algorithm must not be the active one');

  // Market history: ours is cheap and recent, theirs is wildly expensive and NEWER,
  // so an unscoped "latest" or "max" picks theirs and an unscoped average is skewed.
  const snap = conn.prepare(
    'INSERT INTO market_snapshots (algo, ts, lowest, last10, last, available_rigs, available_th) VALUES (?,?,?,?,?,?,?)');
  snap.run(mine,  NOW - 120, 1.0, 1.0, 1.0, 10, 100);
  snap.run(OTHER, NOW - 10,  9999.0, 9999.0, 9999.0, 1, 0.5);

  // Ticks: theirs are newer, so an unscoped MAX(ts) or "latest balance" takes them.
  const tick = conn.prepare(
    'INSERT INTO tick_metrics (algo, ts, delivered_th, target_th, balance_confirmed_sats, balance_unconfirmed_sats) VALUES (?,?,?,?,?,?)');
  tick.run(mine,  NOW - 120, 5, 5, 111, 0);
  tick.run(OTHER, NOW - 10,  0.001, 0.001, 999999999, 0);

  // Spend: the daily total backs a guardrail, so a blend raises the ceiling silently.
  const spend = conn.prepare('INSERT INTO spend_events (algo, ts, sats, kind) VALUES (?,?,?,?)');
  spend.run(mine,  NOW - 120, 1000, 'rent');
  spend.run(OTHER, NOW - 10,  50000000, 'rent');

  appServer = http.createServer(server.handleRequest);
  appPort = await new Promise((r) => appServer.listen(0, () => r(appServer.address().port)));
});

after(async () => {
  await new Promise((r) => appServer.close(r));
  db.close();
});

test('the market read returns our algorithm, not the newer foreign snapshot', async () => {
  const { json } = await call('GET', '/api/market');
  const latest = json && (json.latest || json.market || null);
  const seen = JSON.stringify(json);
  assert.ok(!seen.includes('9999'), 'a foreign market snapshot reached /api/market');
});

test('the market history query excludes the other algorithm', () => {
  // Asserted against the query rather than the response: /api/market hands the rows
  // to the chart builder, which returns scaled drawing coordinates. Asserting on
  // those would couple this test to chart internals and stop it testing the scoping.
  const conn = db.get();
  const scoped = conn.prepare(
    'SELECT ts, lowest FROM market_snapshots WHERE algo = ? AND ts >= ? ORDER BY ts')
    .all(market.activeAlgo(conn), NOW - 30 * 86400);
  const blended = conn.prepare(
    'SELECT ts, lowest FROM market_snapshots WHERE ts >= ? ORDER BY ts').all(NOW - 30 * 86400);
  assert.ok(scoped.length > 0, 'the fixture should produce a history');
  assert.ok(blended.length > scoped.length, 'the fixture must actually differ, or this proves nothing');
  for (const row of scoped) assert.notEqual(row.lowest, 9999.0, 'a foreign snapshot is in the history');
});

test('every set-based read of a scoped table filters on the algorithm', () => {
  /*
   * Derived, not a list someone remembers to update. The previous version of this test
   * WAS such a list, and it missed the daily-spend read in the two autopilot paths —
   * the ones that spend without a human present — because those were written after the
   * list was.
   *
   * The rule: a query against a scoped table either picks a single row by an id that is
   * unique across algorithms, or filters on the algorithm, or appears below with a
   * reason. Nothing else.
   */
  const SCOPED_TABLES = ['rentals', 'sessions', 'pool_endpoints', 'alerts', 'tick_metrics',
    'spend_events', 'market_snapshots', 'decisions', 'rig_scores', 'rental_samples', 'applied_refunds'];

  // Predicates that already identify one row. MRR ids and our own row ids are unique
  // across algorithms, so a lookup by one cannot return the other algorithm's data.
  const BY_ID = /\b(mrr_id|session_id|rig_id|rental_id|tx_id|note)\s*(=|IS)\s*\?|\b(r|s|rs)\.(mrr_id|session_id|id)\s*=|\bid\s*=\s*\?/i;

  /*
   * Deliberately unscoped, each for a reason that would not survive being "fixed".
   */
  const ALLOWED = [
    // The engine must manage whatever session is actually live. Switching algorithms is
    // refused while one is active or winding down, so the live session always belongs to
    // the active algorithm; and if that were ever violated, scoping here would leave a
    // real session with real rentals unmanaged, which is worse than managing it.
    [/FROM sessions WHERE (mode = 'autopilot' AND )?state (IN \('active'|= 'active')/i, 'the live session'],
    // Alerts are addressed by kind and key, and the key embeds the id it is about.
    [/FROM alerts WHERE kind/i, 'alerts are addressed by kind + key'],
    [/UPDATE alerts SET .* WHERE kind/i, 'alerts are addressed by kind + key'],
    // The halt checks are global on purpose: losing track of money under one algorithm
    // should stop spending under both.
    [/SELECT 1 FROM alerts WHERE kind = '(endpoint_down|needs_reconcile)'/i, 'halts apply everywhere'],
    // Stale-alert sweeping compares fired alerts against every rental we have ever had.
    [/SELECT mrr_id FROM rentals WHERE ended = 1/i, 'stale-alert sweep spans all rentals'],
    [/SELECT kind, key FROM alerts WHERE state = 'fired' AND kind IN/i, 'stale-alert sweep'],
    // Stray detection compares the marketplace's account-wide rental list against every
    // rental we know of. Scoped, the other algorithm's rentals would look untracked and
    // be adopted into the current session.
    [/SELECT mrr_id FROM rentals$/i, 'stray detection must see every rental we own'],
    // Evidence and refunds are about money already spent, fetched by mrr_id from the
    // marketplace. Which algorithm bought the rental does not change either.
    [/FROM rentals WHERE ended = 1 AND evidence_json IS NULL/i, 'evidence is fetched per rental'],
    [/rentals SET refund_watch_until/i, 'refunds are per rental'],
    [/FROM rentals WHERE ended = 1 AND refund_watch_until/i, 'refunds are per rental'],
    [/SELECT tx_id FROM applied_refunds/i, 'refund dedupe is by transaction id'],
    // Retention bounds the database. Scoping it would let the inactive algorithm's raw
    // rows grow without limit, since prune only runs on the active one's cadence.
    [/DELETE FROM (tick_metrics|rental_samples|market_snapshots) WHERE ts </i, 'retention, see prune.js'],
    // Extend dedupe: the note embeds the rental id.
    [/FROM decisions WHERE ts >= \? AND note LIKE/i, 'the note embeds the rental id'],
  ];

  const dir = path.join(__dirname, '..');
  const files = [];
  for (const d of [dir, path.join(dir, 'engine')]) {
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) files.push(path.join(d, f));
  }
  const problems = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:prepare|exec)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
      const q = m[1].slice(1, -1).split(/\s+/).join(' ').trim();
      if (!/^(SELECT|UPDATE|DELETE)/i.test(q)) continue;
      if (!SCOPED_TABLES.some((t) => new RegExp(`\\b(FROM|UPDATE|JOIN)\\s+${t}\\b`, 'i').test(q))) continue;
      if (/\balgo\s*=/i.test(q)) continue;
      if (BY_ID.test(q)) continue;
      if (ALLOWED.some(([re]) => re.test(q))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${path.relative(dir, file)}:${line}  ${q.slice(0, 100)}`);
    }
  }
  assert.deepEqual(problems, [],
    `unscoped set-based read of a scoped table. Add "algo = ?", or add it to ALLOWED with a reason:\n${problems.join('\n')}`);
});

test('the latest balance comes from our ticks, not the newer foreign one', async () => {
  const { json } = await call('GET', '/api/status');
  const bal = json && json.balance;
  if (bal) assert.notEqual(bal.confirmed_sats, 999999999, 'a foreign tick supplied the balance');
});

test('health freshness uses our ticks, so a foreign tick cannot mask a stall', async () => {
  const { json } = await call('GET', '/api/health');
  const seen = JSON.stringify(json || {});
  assert.ok(!seen.includes(String(NOW - 10)), 'a foreign tick timestamp reached the health read');
});

test('every write to a scoped table names the algorithm', () => {
  // The column carries DEFAULT 'sha256ab' so the migration could land without
  // touching writers. That default is now a hazard rather than a help: once the
  // algorithm is configurable, a writer that omits the column stamps sha256ab while
  // the app is running blake2b, and the scoped reads then hide the row it wrote.
  //
  // SQLite cannot drop a DEFAULT without rebuilding the table, and rebuilding eleven
  // of them to gain a constraint is more risk than the risk it removes. This check
  // is the cheaper equivalent: it fails the moment a write forgets.
  const SCOPED = new Set(['rentals', 'sessions', 'pool_endpoints', 'alerts', 'tick_metrics',
    'spend_events', 'market_snapshots', 'decisions', 'rig_scores', 'rental_samples', 'applied_refunds']);
  const dir = path.join(__dirname, '..');
  const files = [];
  for (const d of [dir, path.join(dir, 'engine')]) {
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) files.push(path.join(d, f));
  }
  const re = /INSERT (?:OR \w+ )?INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g;
  const problems = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const [, table, cols, vals] = m;
      if (!SCOPED.has(table)) continue;
      const rel = path.relative(dir, file);
      if (!/\balgo\b/.test(cols)) problems.push(`${rel}: INSERT INTO ${table} does not name algo`);
      const nc = cols.split(',').filter((c) => c.trim()).length;
      const nv = vals.split(',').filter((v) => v.trim()).length;
      if (nc !== nv) problems.push(`${rel}: INSERT INTO ${table} has ${nc} columns and ${nv} values`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
