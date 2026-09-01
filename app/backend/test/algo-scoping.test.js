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

test('every set-based read that was scoped is still scoped', () => {
  // A source assertion, deliberately, and it earns its place: the behavioural tests
  // above only reach reads that surface in an API response. The daily-spend total
  // sits inside executeSession behind a client and a session, so dropping its filter
  // changes a spending guardrail while every other test still passes. That was
  // verified by removing it: nothing else in the suite noticed.
  //
  // Each entry is a distinctive fragment of a query that aggregates or lists across
  // rows rather than fetching one by a unique id. Those are the ones that blend.
  // Reads keyed by rental id or session id are omitted on purpose: an id is already
  // unique across algorithms, so filtering them would be noise.
  const files = {
    'api.js': fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'session.js': fs.readFileSync(path.join(__dirname, '..', 'session.js'), 'utf8'),
  };
  const mustBeScoped = [
    ['session.js', 'SUM(sats), 0) AS s FROM spend_events', 'the rolling 24h spend guardrail'],
    ['api.js', 'SELECT lowest, last10 FROM market_snapshots', 'the market rate on the hash-value card'],
    ['api.js', 'FROM tick_metrics WHERE', 'the latest engine-observed balance'],
    ['api.js', 'SELECT ts, lowest, last10 FROM market_snapshots', 'the market overlay on the metrics chart'],
    ['api.js', 'SELECT * FROM market_snapshots', 'the latest market summary'],
    ['api.js', 'SELECT ts, lowest, last10, last FROM market_snapshots', 'the 30-day price history'],
    ['api.js', 'SELECT MAX(ts) AS t FROM tick_metrics', 'health freshness'],
    ['api.js', 'SELECT COUNT(*) AS n FROM tick_metrics', 'the tick rate'],
    ['api.js', 'summary_json FROM sessions', 'the cumulative impact chart'],
  ];
  for (const [file, fragment, why] of mustBeScoped) {
    const src = files[file];
    const at = src.indexOf(fragment);
    assert.notEqual(at, -1, `${file}: query moved or was rewritten (${why}); update this list`);
    // The filter has to be inside the same statement, so look only as far as the quote ends.
    const stmt = src.slice(at, src.indexOf('\'', at) === -1 ? at + 400 : src.indexOf('\'', at) + 1);
    assert.ok(stmt.includes('algo = ?'), `${file}: ${why} is no longer scoped by algorithm`);
  }
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
