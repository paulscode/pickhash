'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// DATA_DIR must be set before requiring the server (read at load time).
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-api-'));
process.env.DATA_DIR = DATA;

const server = require('../server');
const db = require('../db');
const config = require('../config');
const alerts = require('../alerts');

let appServer;
let appPort;

function listen(s) { return new Promise((r) => s.listen(0, () => r(s.address().port))); }

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port: appPort, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null })); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// --- direct-seed helpers (prepared statements) -----------------------------------
function insertSession(row) {
  const r = { mode: 'live', state: 'active', target_th: 1000, budget_sats: null, duration_hours: 24, spent_sats: 0, fee_sats: 0, created_at: 1000, started_at: 1000, ended_at: null, summary_json: null, ...row };
  const info = db.get().prepare(
    `INSERT INTO sessions (mode, state, target_th, budget_sats, duration_hours, spent_sats, fee_sats, created_at, started_at, ended_at, summary_json)
       VALUES (@mode,@state,@target_th,@budget_sats,@duration_hours,@spent_sats,@fee_sats,@created_at,@started_at,@ended_at,@summary_json)`,
  ).run(r);
  return Number(info.lastInsertRowid);
}
function insertTick(row) {
  db.get().prepare('INSERT INTO tick_metrics (ts, session_id, delivered_th, target_th, spent_sats) VALUES (@ts,@session_id,@delivered_th,@target_th,@spent_sats)').run(row);
}
function insertRental(row) {
  const r = { session_id: null, mrr_id: null, rig_id: 1, rig_name: 'Rig', region: 'US', advertised_th: 500, length_hours: 24, paid_sats: 0, fee_sats: 0, rate_btc_th_day: null, start_ts: 1000, end_ts: null, avg_percent: null, ended: 0, refund_sats: 0, evidence_json: null, ...row };
  db.get().prepare(
    `INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, region, advertised_th, length_hours, paid_sats, fee_sats, rate_btc_th_day, start_ts, end_ts, avg_percent, ended, refund_sats, evidence_json)
       VALUES (@session_id,@mrr_id,@rig_id,@rig_name,@region,@advertised_th,@length_hours,@paid_sats,@fee_sats,@rate_btc_th_day,@start_ts,@end_ts,@avg_percent,@ended,@refund_sats,@evidence_json)`,
  ).run(r);
}
function insertSample(row) {
  db.get().prepare('INSERT INTO rental_samples (rental_id, ts, delivered_th, percent, health) VALUES (@rental_id,@ts,@delivered_th,NULL,NULL)').run(row);
}

before(async () => {
  db.open(DATA);
  // Pass the setup gate (isSetupComplete checks config setup.completed === true); leave
  // the password unset so auth is open.
  config.set(db.get(), 'setup', { completed: true });
  appServer = http.createServer(server.handleRequest);
  appPort = await listen(appServer);
});

after(async () => {
  await new Promise((r) => appServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('GET /api/metrics on an empty DB returns valid, empty chart models', async () => {
  const r = await call('GET', '/api/metrics');
  assert.equal(r.status, 200);
  assert.equal(r.json.range, 'all');
  assert.equal(r.json.delivered.series[0].points.length, 0);
  assert.equal(r.json.spend.series[0].points.length, 0);
  assert.equal(r.json.spend.ceiling, null, 'no budget -> no ceiling');
  assert.equal(r.json.market.series.length, 2, 'market always has both series');
  assert.equal(r.json.delivered_stacked.empty, true);
});

test('GET /api/metrics is scoped to the LATEST session only (never blends A and B)', async () => {
  // Session A (older) — must be excluded from the metrics.
  const a = insertSession({ target_th: 1000 });
  insertTick({ ts: 1000, session_id: a, delivered_th: 900, target_th: 1000, spent_sats: 999000 });
  insertTick({ ts: 1100, session_id: a, delivered_th: 900, target_th: 1000, spent_sats: 999000 });
  insertRental({ session_id: a, mrr_id: 101, rig_name: 'AlphaRig', advertised_th: 1000 });
  insertSample({ rental_id: 101, ts: 1000, delivered_th: 900 });
  insertSample({ rental_id: 101, ts: 1100, delivered_th: 900 });

  // Session B (latest) — the only one the metrics should reflect.
  const b = insertSession({ target_th: 1000 });
  insertTick({ ts: 2000, session_id: b, delivered_th: 500, target_th: 1000, spent_sats: 3000 });
  insertTick({ ts: 2100, session_id: b, delivered_th: 600, target_th: 1000, spent_sats: 4200 });
  insertRental({ session_id: b, mrr_id: 201, rig_name: 'BravoRig', advertised_th: 1000 });
  insertSample({ rental_id: 201, ts: 2000, delivered_th: 500 });
  insertSample({ rental_id: 201, ts: 2100, delivered_th: 600 });

  const r = await call('GET', '/api/metrics');
  assert.equal(r.status, 200);
  // delivered/spend reflect only B's two ticks.
  assert.equal(r.json.delivered.series[0].points.length, 2);
  const spendVals = r.json.spend.series[0].points.map((p) => p.vy);
  assert.deepEqual(spendVals, [3000, 4200], 'only B spend, never blended with A (999000)');
  assert.ok(!spendVals.includes(999000));
  // stacked bands come from B's rig, not A's.
  const labels = r.json.delivered_stacked.bands.map((band) => band.label);
  assert.ok(labels.includes('BravoRig'));
  assert.ok(!labels.includes('AlphaRig'), 'prior-session rig must not appear');
});

test('GET /api/metrics?range=6h filters ticks by ts', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Session C (newest) with one tick outside the 6h window and one inside.
  const c = insertSession({ target_th: 1000 });
  insertTick({ ts: now - 10 * 3600, session_id: c, delivered_th: 100, target_th: 1000, spent_sats: 100 });
  insertTick({ ts: now - 1 * 3600, session_id: c, delivered_th: 200, target_th: 1000, spent_sats: 200 });

  const all = await call('GET', '/api/metrics?range=all');
  assert.equal(all.json.delivered.series[0].points.length, 2);

  const recent = await call('GET', '/api/metrics?range=6h');
  assert.equal(recent.json.range, '6h');
  assert.equal(recent.json.delivered.series[0].points.length, 1, 'the 10h-old tick is filtered out');
});

test('GET /api/session/history excludes dry-run rehearsals and returns real ended sessions', async () => {
  const dry = insertSession({ state: 'ended', ended_at: 5000, summary_json: JSON.stringify({ dry_run: true }) });
  const real = insertSession({
    state: 'ended', ended_at: 6000, spent_sats: 12000, target_th: 1000,
    summary_json: JSON.stringify({ effective_sats_per_th_day: 42, delivered_th_hours: 1234, refund_sats: 300 }),
  });
  // Disputable rig: ended with avg_percent null -> disputable via the `|| avg_percent == null` clause.
  insertRental({ session_id: real, mrr_id: 301, rig_name: 'EndedRig', end_ts: 6000, avg_percent: null, paid_sats: 3000, fee_sats: 200, refund_sats: 500 });
  // Still-running rig (no end_ts) -> not disputable.
  insertRental({ session_id: real, mrr_id: 302, rig_name: 'LiveRig', end_ts: null, avg_percent: null, paid_sats: 1000, fee_sats: 100, refund_sats: 0 });

  const r = await call('GET', '/api/session/history');
  assert.equal(r.status, 200);
  const ids = r.json.sessions.map((s) => s.id);
  assert.ok(!ids.includes(dry), 'dry-run session is excluded from history');
  const real0 = r.json.sessions.find((s) => s.id === real);
  assert.ok(real0, 'the real ended session appears');
  assert.equal(real0.effective_sats_per_th_day, 42);
  assert.equal(real0.delivered_th_hours, 1234);

  const ended = real0.rigs.find((rig) => rig.rig_id === 1 && rig.name === 'EndedRig');
  assert.equal(ended.disputable, true, 'ended + avg_percent null -> disputable');
  assert.ok(ended.deadline_ts != null && ended.deadline_ts > 6000, 'deadline computed from end_ts');
  assert.ok(ended.links && ended.links.rental && ended.links.tickets, 'dispute links present');
  assert.ok(typeof ended.evidence_text === 'string' && ended.evidence_text.length > 0);
  // Per-rig cost = paid + fee; refund carried through.
  assert.equal(ended.cost_sats, 3200);
  assert.equal(ended.refund_sats, 500);

  const live = real0.rigs.find((rig) => rig.name === 'LiveRig');
  assert.equal(live.disputable, false, 'no end_ts -> not disputable');
  assert.equal(live.deadline_ts, null);
  assert.equal(live.links, null);
  assert.equal(live.evidence_text, null);
  assert.equal(live.cost_sats, 1100);
});

test('GET /api/alerts lists an active alert; POST /api/alerts/ack removes it; bad id is 400', async () => {
  const fired = alerts.fireOnce(db.get(), { kind: 'session_ended', key: 'ack-test', now: Date.now() });
  assert.ok(fired && fired.id, 'seeded a fired alert');

  let r = await call('GET', '/api/alerts');
  assert.equal(r.status, 200);
  assert.ok(r.json.alerts.some((a) => a.id === fired.id), 'GET lists the active alert');

  // A non-integer id is rejected.
  const bad = await call('POST', '/api/alerts/ack', { id: 'not-a-number' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'id_required');

  const acked = await call('POST', '/api/alerts/ack', { id: fired.id });
  assert.equal(acked.status, 200);
  assert.equal(acked.json.ok, true);

  r = await call('GET', '/api/alerts');
  assert.ok(!r.json.alerts.some((a) => a.id === fired.id), 'acked alert no longer listed');
});

test('GET /api/status carries active alerts', async () => {
  const fired = alerts.fireOnce(db.get(), { kind: 'refund_received', key: 'status-test', now: Date.now() });
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.alerts));
  assert.ok(r.json.alerts.some((a) => a.id === fired.id && a.kind === 'refund_received'), 'status body includes the active alert');
});

test('POST /api/run-mode: dry-run is free; going live needs MRR configured', async () => {
  const dry = await call('POST', '/api/run-mode', { mode: 'dry-run' });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.mode, 'dry-run');
  // No MRR key stored in this harness -> going live is refused.
  const live = await call('POST', '/api/run-mode', { mode: 'live' });
  assert.equal(live.status, 400);
  assert.equal(live.json.error, 'mrr_not_configured');
});

test('POST /api/run-mode: a withdraw-capable key needs a typed LIVE confirmation once', async () => {
  const c = db.get();
  process.env.DASHBOARD_PASSWORD = 'x';   // managed password satisfies the password-before-LIVE gate
  c.prepare("INSERT OR REPLACE INTO secrets (name, blob, updated_at) VALUES ('mrr_key', ?, 1)").run(Buffer.from('x'));
  config.set(c, 'mrr', { withdraw_capable: true });
  // Without the phrase -> confirmation required.
  const noConfirm = await call('POST', '/api/run-mode', { mode: 'live' });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.error, 'confirmation_required');
  assert.equal(noConfirm.json.withdraw_capable, true);
  // Wrong phrase -> still required.
  assert.equal((await call('POST', '/api/run-mode', { mode: 'live', confirm: 'yes' })).json.error, 'confirmation_required');
  // Correct typed phrase -> live, and it's remembered (live_confirmed) for next time.
  const ok = await call('POST', '/api/run-mode', { mode: 'live', confirm: 'LIVE' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mode, 'live');
  assert.equal(config.getKey(c, 'run', 'live_confirmed'), true);
  // A later live switch no longer needs the phrase.
  await call('POST', '/api/run-mode', { mode: 'dry-run' });
  assert.equal((await call('POST', '/api/run-mode', { mode: 'live' })).json.mode, 'live');
  delete process.env.DASHBOARD_PASSWORD;
});

test('POST /api/run-mode: a rent-only (non-withdraw) key reaches LIVE with no typed confirm', async () => {
  const c = db.get();
  process.env.DASHBOARD_PASSWORD = 'x';   // managed password satisfies the password-before-LIVE gate
  c.prepare("INSERT OR REPLACE INTO secrets (name, blob, updated_at) VALUES ('mrr_key', ?, 1)").run(Buffer.from('x'));
  config.set(c, 'mrr', { withdraw_capable: false });
  // Clear any prior confirmation so we prove the typed gate simply never applies here.
  config.set(c, 'run', { mode: 'dry-run', live_confirmed: false });

  const live = await call('POST', '/api/run-mode', { mode: 'live' });
  assert.equal(live.status, 200);
  assert.equal(live.json.mode, 'live', 'LIVE is reachable for a rent-only key with no confirm phrase');
  // The typed-LIVE gate is withdraw-only: no confirmation demanded, none recorded.
  assert.notEqual(config.getKey(c, 'run', 'live_confirmed'), true, 'live_confirmed is not set for a rent-only key');
  delete process.env.DASHBOARD_PASSWORD;
});

test('POST /api/autopilot/start without MRR configured -> 400 mrr_not_configured', async () => {
  // No mrr_secret in this harness -> clientFromStore yields no client -> the guard fires.
  const r = await call('POST', '/api/autopilot/start', { target_th: 100, time_cap_hours: 24, budget_sats: 100000 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'mrr_not_configured');
});

test('GET /api/autopilot/estimate without MRR configured -> 400 mrr_not_configured (before bad_params)', async () => {
  // Even with invalid params, the client guard is checked first — order matters.
  const r = await call('GET', '/api/autopilot/estimate?target_th=0&budget_sats=0');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'mrr_not_configured');
});

test('POST /api/session/stop ends the current (no-live-rental) session', async () => {
  const sid = insertSession({ mode: 'autopilot', state: 'active', target_th: 200 });   // latest id -> the one stopped
  const r = await call('POST', '/api/session/stop', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'ended');
  assert.equal(db.get().prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'ended');
});

test('GET /api/status carries the latest engine-observed balance (for the live balance card)', async () => {
  const now = Math.floor(Date.now() / 1000);
  db.get().prepare('INSERT INTO tick_metrics (ts, session_id, balance_confirmed_sats, balance_unconfirmed_sats) VALUES (?, NULL, ?, ?)')
    .run(now + 1, 47_000, 3_000);
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.ok(r.json.balance, 'balance present');
  assert.equal(r.json.balance.confirmed_sats, 47_000);
  assert.equal(r.json.balance.unconfirmed_sats, 3_000);
});

test('POST /api/rig/blacklist toggles the strategy blacklist; history reflects blacklist + score', async () => {
  const c = db.get();
  const s = insertSession({ state: 'ended', ended_at: 6000, summary_json: JSON.stringify({ spent_sats: 100 }) });
  insertRental({ session_id: s, mrr_id: 900, rig_id: 42, rig_name: 'ScoreRig', end_ts: 5000, avg_percent: 88 });
  c.prepare('INSERT INTO rig_scores (rig_id, rentals, mean_percent) VALUES (42, 3, 88.4)').run();

  const on = await call('POST', '/api/rig/blacklist', { rig_id: 42, blacklisted: true });
  assert.equal(on.status, 200);
  assert.ok(on.json.blacklist_rig_ids.includes(42), 'rig added to the blacklist');

  const h = await call('GET', '/api/session/history');
  const rig = h.json.sessions.flatMap((x) => x.rigs).find((r) => r.rig_id === 42);
  assert.equal(rig.blacklisted, true, 'history shows the blacklist flag');
  assert.equal(rig.score_percent, 88.4, 'history shows the learned score');
  assert.equal(rig.score_rentals, 3);

  const off = await call('POST', '/api/rig/blacklist', { rig_id: 42, blacklisted: false });
  assert.ok(!off.json.blacklist_rig_ids.includes(42), 'rig removed from the blacklist');

  assert.equal((await call('POST', '/api/rig/blacklist', { rig_id: 'nope' })).status, 400, 'bad rig_id -> 400');
});

test('GET /api/config returns schema + values with NO secrets; POST round-trips a validated patch', async () => {
  const g = await call('GET', '/api/config');
  assert.equal(g.status, 200);
  assert.ok(g.json.schema.strategy && g.json.schema.guardrails, 'schema grouped by namespace');
  assert.ok(!g.json.schema.notifications, 'Telegram/notifications is deferred — not in the settable schema');
  assert.equal(g.json.values.ui.hashrate_unit, 'ph', 'current value present');
  assert.ok(!/mrr_key|mrr_secret|password/i.test(JSON.stringify(g.json)), 'no credentials in GET /api/config');

  const ok = await call('POST', '/api/config', { ns: 'strategy', patch: { max_overshoot_pct: 150 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.values.max_overshoot_pct, 150);
  assert.equal((await call('GET', '/api/config')).json.values.strategy.max_overshoot_pct, 150, 'persisted');

  const bad = await call('POST', '/api/config', { ns: 'strategy', patch: { min_rpi: 999 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_setting');
  assert.equal(bad.json.field, 'min_rpi');
  assert.equal((await call('POST', '/api/config', { ns: 'run', patch: { mode: 'live' } })).status, 400, 'run is not a settings namespace');
});

test('GET /api/diag reports engine liveness + MRR identity, no secrets', async () => {
  const r = await call('GET', '/api/diag');
  assert.equal(r.status, 200);
  assert.ok('configured' in r.json.mrr, 'mrr block present');
  assert.ok('ticks_last_hour' in r.json.engine, 'engine liveness present');
  assert.ok('endpoint' in r.json, 'active endpoint reported (null when none) for the Settings editor');
  assert.equal(r.json.fallback.pool, 'Ocean', 'fallback pool surfaced for the UI');
  assert.equal(r.json.fallback.enabled, true, 'on by default');
  assert.ok(!/mrr_key|mrr_secret|password/i.test(JSON.stringify(r.json)), 'no secrets in diag');
});

test('GET /api/market returns depth, regions, price history, and a cheap-now read from snapshots', async () => {
  const c = db.get();
  c.prepare('DELETE FROM market_snapshots').run();
  const now = Math.floor(Date.now() / 1000);
  const depth = [{ priceBtcThDay: 1e-6, th: 100, region: 'us' }, { priceBtcThDay: 2e-6, th: 200, region: 'eu' }];
  c.prepare('INSERT INTO market_snapshots (ts, lowest, last10, last, available_rigs, available_th, depth_json) VALUES (?,?,?,?,?,?,?)')
    .run(now - 3600, 2e-6, null, null, 2, 300, '[]');
  c.prepare('INSERT INTO market_snapshots (ts, lowest, last10, last, available_rigs, available_th, depth_json) VALUES (?,?,?,?,?,?,?)')
    .run(now, 1e-6, 1.5e-6, 1.2e-6, 2, 300, JSON.stringify(depth));
  const r = await call('GET', '/api/market');
  assert.equal(r.status, 200);
  assert.equal(r.json.summary.available_th, 300);
  assert.equal(r.json.summary.lowest_sats_ph_day, 100000, 'lowest 1e-6 BTC/TH·day -> 100k sats/PH·day');
  assert.equal(r.json.depth_chart.total_th, 300);
  assert.deepEqual(r.json.regions.map((x) => x.region), ['eu', 'us'], 'eu 200 TH ranks above us 100 TH');
  assert.equal(r.json.cheap_now.available, true);
  assert.equal(r.json.cheap_now.label, 'cheap', 'current 1e-6 is below the prior 2e-6');
  assert.ok(r.json.price_history.series.length >= 1, 'price-history chart present');
});

test('owner messaging guards: bad id, unknown rental, empty/too-long message, unconfigured MRR', async () => {
  assert.equal((await call('GET', '/api/rental/messages?mrr_id=nope')).status, 400, 'GET bad id');
  assert.equal((await call('GET', '/api/rental/messages?mrr_id=99999')).status, 404, 'GET unknown rental');
  const s = insertSession({});
  insertRental({ session_id: s, mrr_id: 7001, rig_id: 5 });
  assert.equal((await call('GET', '/api/rental/messages?mrr_id=7001')).json.error, 'mrr_not_configured', 'GET known rental, no MRR client');
  assert.equal((await call('POST', '/api/rental/messages', { mrr_id: 7001, message: '   ' })).json.error, 'empty_message');
  assert.equal((await call('POST', '/api/rental/messages', { mrr_id: 7001, message: 'x'.repeat(2001) })).json.error, 'message_too_long');
  assert.equal((await call('POST', '/api/rental/messages', { mrr_id: 88888, message: 'hi' })).status, 404, 'POST unknown rental');
  assert.equal((await call('POST', '/api/rental/messages', { mrr_id: 7001, message: 'hi' })).json.error, 'mrr_not_configured');
});

test('hash value: /api/status + /api/market compare your pay-rate to the market rate', async () => {
  const c = db.get();
  c.prepare('DELETE FROM market_snapshots').run();
  const now = Math.floor(Date.now() / 1000);
  c.prepare('INSERT INTO market_snapshots (ts, lowest, last10, available_rigs, available_th, depth_json) VALUES (?,?,?,?,?,?)').run(now, 4e-7, 5e-7, 1, 100, '[]');
  const s = insertSession({ state: 'active' });
  insertRental({ session_id: s, mrr_id: 8001, advertised_th: 100, avg_percent: 90 });
  c.prepare('UPDATE rentals SET rate_btc_th_day = ?, ended = 0 WHERE mrr_id = 8001').run(5.2e-7);
  const st = await call('GET', '/api/status');
  assert.equal(st.json.hash_value.market_sats_ph_day, 50000);
  assert.equal(st.json.hash_value.your_pay_sats_ph_day, 52000);
  assert.equal(st.json.hash_value.over_market_pct, 4);
  const mk = await call('GET', '/api/market');
  assert.equal(mk.json.hash_value.available, true);
  assert.equal(mk.json.price_history.pay_value, 52000, 'pay overlay carried onto the price-history chart');
});

test('GET /api/metrics overlays the pay-rate on its market chart', async () => {
  const c = db.get();
  c.prepare('DELETE FROM market_snapshots').run();
  const now = Math.floor(Date.now() / 1000);
  c.prepare('INSERT INTO market_snapshots (ts, lowest, last10, available_rigs, available_th, depth_json) VALUES (?,?,?,?,?,?)').run(now, 4e-7, 5e-7, 1, 100, '[]');
  const s = insertSession({ state: 'active' });
  insertRental({ session_id: s, mrr_id: 8101, advertised_th: 100, avg_percent: 90 });
  c.prepare('UPDATE rentals SET rate_btc_th_day = ?, ended = 0 WHERE mrr_id = 8101').run(5.2e-7);
  const r = await call('GET', '/api/metrics');
  assert.equal(r.json.market.pay_value, 52000, 'pay overlay present on the metrics market chart');
});

test('hash value card is live-only, but the market "you" overlay persists after a session ends', async () => {
  const c = db.get();
  c.prepare('DELETE FROM market_snapshots').run();
  c.prepare("UPDATE sessions SET state = 'ended' WHERE state IN ('active','winding_down')").run();
  const now = Math.floor(Date.now() / 1000);
  c.prepare('INSERT INTO market_snapshots (ts, lowest, last10, available_rigs, available_th, depth_json) VALUES (?,?,?,?,?,?)').run(now, 4e-7, 5e-7, 1, 100, '[]');
  // The most recent session ended, but it rented (55,000 sats/PH·day) — the overlay should persist.
  const ended = insertSession({ state: 'ended' });
  insertRental({ session_id: ended, mrr_id: 8201, rate_btc_th_day: 5.5e-7, advertised_th: 100, ended: 1 });

  const st = await call('GET', '/api/status');
  assert.equal(st.json.hash_value.available, false, 'the LIVE comparison card needs an active session');
  assert.equal(st.json.hash_value.your_pay_sats_ph_day, null, 'card pay-rate is live-only');
  const mk = await call('GET', '/api/market');
  assert.equal(mk.json.price_history.pay_value, 55000, 'the "you" overlay persists from the last session that rented');
  assert.equal(mk.json.price_history.pay_live, false, 'flagged not-live so the legend reads "you (last)"');
});

test('GET /api/status carries each rental\'s delivery percentage (for the health badge)', async () => {
  const c = db.get();
  c.prepare("UPDATE sessions SET state = 'ended' WHERE state IN ('active','winding_down')").run();
  const s = insertSession({ state: 'active' });
  insertRental({ session_id: s, mrr_id: 7777, advertised_th: 100, avg_percent: 78 });
  c.prepare("UPDATE rentals SET health = 'degraded' WHERE mrr_id = 7777").run();
  const r = await call('GET', '/api/status');
  const row = (r.json.rentals || []).find((x) => x.mrr_id === 7777);
  assert.ok(row, 'rental present in status');
  assert.equal(row.avg_percent, 78, 'delivery percentage flows through for the badge readout');
  assert.equal(row.health, 'degraded');
});

test('POST /api/run-mode: going live is refused until a dashboard password exists', async () => {
  delete process.env.DASHBOARD_PASSWORD;   // not platform-managed
  const c = db.get();
  c.prepare("INSERT OR REPLACE INTO secrets (name, blob, updated_at) VALUES ('mrr_key', ?, 1)").run(Buffer.from('x'));
  // No dashboard_password secret and not managed -> the spend gate blocks LIVE.
  c.prepare("DELETE FROM secrets WHERE name = 'dashboard_password'").run();
  const r = await call('POST', '/api/run-mode', { mode: 'live' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'password_required');
  // DRY-RUN stays available without a password.
  assert.equal((await call('POST', '/api/run-mode', { mode: 'dry-run' })).json.mode, 'dry-run');
});

test('POST /api/setup/pool-test: refuses a link-local / cloud-metadata target', async () => {
  process.env.DASHBOARD_PASSWORD = 'x';   // managed -> pass the password-before-probe gate
  const r = await call('POST', '/api/setup/pool-test', { host: '169.254.169.254', port: 80, user: 'bc1qaddr.w' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'endpoint_not_allowed');
  delete process.env.DASHBOARD_PASSWORD;
});

test('POST /api/setup/mrr-keys: refused until a dashboard password protects the credentials', async () => {
  delete process.env.DASHBOARD_PASSWORD;
  db.get().prepare("DELETE FROM secrets WHERE name = 'dashboard_password'").run();
  const r = await call('POST', '/api/setup/mrr-keys', { key: 'k', secret: 's' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'password_required');
});

test('a mutating request carrying a non-JSON body is refused (blocks form-based CSRF)', async () => {
  const data = JSON.stringify({ mode: 'dry-run' });
  const r = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: appPort, path: '/api/run-mode', method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(data) } },
      (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null })); },
    );
    req.on('error', reject); req.write(data); req.end();
  });
  assert.equal(r.status, 415);
  assert.equal(r.json.error, 'unsupported_media_type');
});

test('every money route refuses cleanly when MRR is not configured (no client -> mrr_not_configured)', async () => {
  // The api harness stores no MRR credentials, so clientFromStore yields null for each route.
  for (const [method, p, body] of [
    ['GET', '/api/deposit', undefined],
    ['POST', '/api/quote', { compute: 'duration' }],
    ['POST', '/api/session', { quote_id: 'x' }],
    ['POST', '/api/autopilot/start', { target_th: 100, time_cap_hours: 24, budget_sats: 100000 }],
  ]) {
    const r = await call(method, p, body);
    assert.equal(r.status, 400, `${p} -> 400`);
    assert.equal(r.json.error, 'mrr_not_configured', `${p} refuses without MRR`);
  }
});

test('payRateSatsPhDay: the "you" line persists after a session ends (most recent priced session)', () => {
  const api = require('../api');
  // Older ended Autopilot session at 60,000 sats/PH·day (6e-7 BTC/TH·day x 1e11).
  const older = insertSession({ mode: 'live', state: 'ended' });
  insertRental({ session_id: older, mrr_id: 6001, rate_btc_th_day: 6e-7, advertised_th: 100, ended: 1 });
  // Newer ended Quick Rent at 50,000 — the most recent priced session, so the "you" line shows this.
  const quick = insertSession({ mode: 'quick', state: 'ended' });
  insertRental({ session_id: quick, mrr_id: 6002, rate_btc_th_day: 5e-7, advertised_th: 100, ended: 1 });
  assert.deepEqual(api.payRateSatsPhDay(db.get()), { rate: 50000, live: false }, 'most recent (Quick Rent) rate, marked not-live (labels "you (last)")');

  // A newest spend-free session (DRY-RUN: no priced rentals) must NOT blank the line.
  const dry = insertSession({ mode: 'live', state: 'ended' });
  insertRental({ session_id: dry, mrr_id: 6003, advertised_th: 100 });   // rate null -> unpriced, skipped
  assert.deepEqual(api.payRateSatsPhDay(db.get()), { rate: 50000, live: false }, 'spend-free session skipped; last priced rate stays');

  // An ACTIVE session with live rentals overrides the fallback with its current rate, marked live.
  const live = insertSession({ mode: 'live', state: 'active' });
  insertRental({ session_id: live, mrr_id: 6004, rate_btc_th_day: 4e-7, advertised_th: 100, ended: 0 });
  assert.deepEqual(api.payRateSatsPhDay(db.get()), { rate: 40000, live: true }, 'active session live rate wins, marked live ("you")');
});
