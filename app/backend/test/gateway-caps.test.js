'use strict';
/*
 * Does the endpoint's Datum Gateway serve rented rigs below the pool minimum?
 *
 * Asked via datum.capabilities (PaulsCode builds answer, every other Gateway says "Method not
 * found"), assessed into ready / disabled / outdated / unknown, re-checked by the engine so a
 * gateway_outdated alert clears by itself after an upgrade, and never warned about when
 * nothing is known.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('node:net');
const db = require('../db');
const stratum = require('../stratum');
const gateway = require('../gateway');
const alerts = require('../alerts');
const observe = require('../engine/observe');
const market = require('../market');

const READY = { gateway: 'v0.5.0-beta/abc', algo: 'blake2b', features: { vardiff_below_pool_min: true, password_difficulty: true, reject_tls_probe: true }, pooled: true, pool_min_diff: 1048576 };

// A fake Datum Gateway. caps: an object to answer datum.capabilities with, 'notfound' for a
// Gateway without the method, or 'silent' to never answer it. Serves work to rig probes.
function fakeGateway(state) {
  return net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        state.requests = (state.requests || 0) + (m.method === 'datum.capabilities' ? 1 : 0);
        if (m.method === 'datum.capabilities') {
          if (state.caps === 'silent') continue;
          if (state.caps === 'notfound') sock.write(`${JSON.stringify({ error: [-3, 'Method not found', null], id: m.id, result: null })}\n`);
          else sock.write(`${JSON.stringify({ error: null, id: m.id, result: state.caps })}\n`);
        }
        if (m.method === 'mining.subscribe') {
          sock.write(`${JSON.stringify({ id: m.id, result: [[['mining.notify', '1']], 'e', 4], error: null })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [4096] })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.notify', params: ['job'] })}\n`);
        }
        if (m.method === 'mining.authorize') sock.write(`${JSON.stringify({ id: m.id, result: true, error: null })}\n`);
      }
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// ---- pure assessment ----

test('assess: feature on is ready, off is disabled, missing or Method not found is outdated, no answer is unknown', () => {
  const opts = { algo: 'blake2b', platform: 'startos' };
  assert.equal(gateway.assess({ supported: true, caps: READY }, opts).status, 'ready');
  assert.equal(gateway.assess({ supported: true, caps: { ...READY, features: { ...READY.features, vardiff_below_pool_min: false } } }, opts).status, 'disabled');
  assert.equal(gateway.assess({ supported: true, caps: { gateway: 'x', features: {} } }, opts).status, 'outdated',
    'a Gateway that answers but predates the feature is outdated');
  assert.equal(gateway.assess({ supported: false, error: 'Method not found' }, opts).status, 'outdated');
  assert.equal(gateway.assess({ supported: null, error: 'timeout' }, opts).status, 'unknown');
  assert.equal(gateway.assess(null, opts).status, 'unknown');
  const a = gateway.assess({ supported: true, caps: READY }, opts);
  assert.equal(a.poolMinDiff, 1048576);
  assert.equal(a.gateway, 'v0.5.0-beta/abc');
  assert.equal(gateway.needsAttention(a), false);
  assert.equal(gateway.needsAttention(gateway.assess({ supported: false }, opts)), true);
  assert.equal(gateway.needsAttention(gateway.assess({ supported: null }, opts)), false, 'nothing known is never warned about');
});

test('the app and store named are the ones on the user\'s platform, for the active algorithm', () => {
  assert.equal(gateway.recommendedApp('blake2b', 'startos'), 'Datum Gateway (BLAKE2b)');
  assert.equal(gateway.recommendedApp('sha256ab', 'startos'), 'Datum Gateway (SHA256)');
  assert.equal(gateway.recommendedApp('blake2b', 'umbrel'), 'Datum (BLAKE2b)', 'Umbrel lists the shorter name');
  assert.equal(gateway.storeFor('startos').url, gateway.REGISTRY_URL);
  assert.equal(gateway.storeFor('umbrel').url, gateway.UMBREL_STORE_URL);
  assert.equal(gateway.platform({ PICKHASH_PLATFORM: 'umbrel' }), 'umbrel');
  assert.equal(gateway.platform({ HASHGG_HOST: 'hashgg.startos' }), 'startos', 'inferred from the HashGG address the package passes');
  assert.equal(gateway.platform({ HASHGG_HOST: 'paulscode-hashgg_web_1' }), 'umbrel');
  assert.equal(gateway.platform({}), null);
});

// ---- the probe ----

test('capabilities: a PaulsCode Gateway answers, a stock one says Method not found, a silent one is unknown', async () => {
  const state = { caps: READY };
  const srv = fakeGateway(state);
  const port = await listen(srv);
  try {
    let r = await stratum.capabilities('127.0.0.1', port, { timeoutMs: 2000 });
    assert.equal(r.supported, true);
    assert.deepEqual(r.caps.features, READY.features);
    state.caps = 'notfound';
    r = await stratum.capabilities('127.0.0.1', port, { timeoutMs: 2000 });
    assert.equal(r.supported, false);
    assert.equal(r.answered, true);
    state.caps = 'silent';
    r = await stratum.capabilities('127.0.0.1', port, { timeoutMs: 300 });
    assert.equal(r.supported, null, 'no answer is not evidence of anything');
    assert.equal(r.error, 'timeout');
  } finally { srv.close(); }
  const bad = await stratum.capabilities('127.0.0.1', 0, { timeoutMs: 300 });
  assert.equal(bad.error, 'bad_port', 'never throws on a bad port');
});

// ---- engine re-check and alert ----

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-gwcaps-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const conn = db.get();
  conn.prepare('DELETE FROM alerts').run();
  conn.prepare('DELETE FROM pool_endpoints').run();
});

function client() {
  return {
    async get(p) {
      if (p === '/rental') return { records: [] };
      if (p === '/account/balance') return { BTC: { confirmed: '0.001', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      return {};
    },
  };
}

test('the engine re-checks the Gateway, records it on the endpoint, and the alert clears after an upgrade', async () => {
  const conn = db.get();
  const state = { caps: 'notfound' };
  const srv = fakeGateway(state);
  const port = await listen(srv);
  try {
    conn.prepare("INSERT INTO pool_endpoints (algo, host, port, worker_base, active) VALUES (?, '127.0.0.1', ?, 'bc1qx.w', 1)")
      .run(require('../market').activeAlgo(conn), port);
    const t0 = 1_700_000_000_000;
    // Tick 1: a stock Gateway. Recorded, and the alert fires.
    let out = await observe.observe(conn, client(), { now: t0, marketSkip: true, prevState: { rentals: {}, marketAt: t0, refundAt: t0 } });
    assert.equal(out.snapshot.gateway.status, 'outdated');
    const row = conn.prepare('SELECT gateway_json FROM pool_endpoints').get();
    assert.equal(JSON.parse(row.gateway_json).status, 'outdated');
    let ev = alerts.evaluate(conn, out.snapshot, {}, t0);
    assert.ok(ev.some((e) => e.kind === 'gateway_outdated' && e.event === 'fired'));

    // Tick 2, a minute later: not re-asked yet (30 min cadence), and the alert holds.
    const asked = state.requests;
    out = await observe.observe(conn, client(), { now: t0 + 60_000, marketSkip: true, prevState: { ...out.nextState, marketAt: t0 + 60_000, refundAt: t0 } });
    assert.equal(state.requests, asked, 'the Gateway is not asked every tick');
    assert.equal(out.snapshot.gateway.status, 'outdated');

    // The user upgrades the Gateway. After the cadence the engine re-asks, and it resolves.
    state.caps = READY;
    const t2 = t0 + 31 * 60_000;
    out = await observe.observe(conn, client(), { now: t2, marketSkip: true, prevState: { ...out.nextState, marketAt: t2, refundAt: t2 } });
    assert.equal(out.snapshot.gateway.status, 'ready');
    ev = alerts.evaluate(conn, out.snapshot, {}, t2);
    assert.ok(ev.some((e) => e.kind === 'gateway_outdated' && e.event === 'resolved'));

    // A Gateway that stops answering keeps what was last known, rather than flapping to unknown.
    state.caps = 'silent';
    const t3 = t2 + 31 * 60_000;
    out = await observe.observe(conn, client(), { now: t3, marketSkip: true, probeTimeoutMs: 300, prevState: { ...out.nextState, marketAt: t3, refundAt: t3 } });
    assert.equal(out.snapshot.gateway.status, 'ready');
  } finally { srv.close(); }
});

test('after a restart the last known Gateway status is read back from the endpoint row', async () => {
  const conn = db.get();
  conn.prepare("INSERT INTO pool_endpoints (algo, host, port, worker_base, active, gateway_json) VALUES (?, '127.0.0.1', 1, 'bc1qx.w', 1, ?)")
    .run(require('../market').activeAlgo(conn), JSON.stringify({ status: 'outdated', app: 'Datum Gateway (BLAKE2b)' }));
  // Port 1 refuses: the endpoint is down, so nothing is re-asked; the stored status stands.
  const t0 = 1_700_000_000_000;
  const out = await observe.observe(conn, client(), { now: t0, marketSkip: true, probeTimeoutMs: 300, prevState: { rentals: {}, marketAt: t0, refundAt: t0 } });
  assert.equal(out.snapshot.gateway.status, 'outdated');
});

test('a standing alert follows the Gateway from "install it" to "switch it on"', () => {
  const conn = db.get();
  const base = { rentals: [], fetch_ok: {} };
  const outdated = { status: 'outdated', app: 'Datum Gateway (BLAKE2b)', store: { url: gateway.REGISTRY_URL } };
  alerts.evaluate(conn, { ...base, gateway: outdated }, {}, 1000);
  alerts.evaluate(conn, { ...base, gateway: { ...outdated, status: 'disabled' } }, {}, 2000);
  const rows = conn.prepare("SELECT state, context_json FROM alerts WHERE kind = 'gateway_outdated'").all();
  assert.equal(rows.length, 1, 'still one alert');
  assert.equal(rows[0].state, 'fired');
  assert.equal(JSON.parse(rows[0].context_json).status, 'disabled');
});

test('no alert when nothing is known about the Gateway', () => {
  const conn = db.get();
  const ev = alerts.evaluate(conn, { rentals: [], fetch_ok: {}, gateway: null }, {}, 1000);
  assert.equal(ev.filter((e) => e.kind === 'gateway_outdated').length, 0);
  const ev2 = alerts.evaluate(conn, { rentals: [], fetch_ok: {}, gateway: { status: 'unknown' } }, {}, 2000);
  assert.equal(ev2.filter((e) => e.kind === 'gateway_outdated').length, 0);
});

test('a hostile endpoint cannot crash the process: non-object replies end the probe quietly', async () => {
  for (const reply of ['null', '1', '"x"', '[1,2]', 'true']) {
    const srv = net.createServer((c) => { c.on('error', () => {}); c.on('data', () => c.write(reply + '\n')); });
    const port = await listen(srv);
    try {
      const caps = await stratum.capabilities('127.0.0.1', port, { timeoutMs: 400 });
      assert.equal(caps.supported, null, `capabilities on ${reply}`);
      const p = await stratum.probe('127.0.0.1', port, 'u', { timeoutMs: 400 });
      assert.equal(p.gotWork, false, `probe on ${reply}`);
    } finally { srv.close(); }
  }
});

test('the alert is per algorithm, so the dashboard for each shows its own', () => {
  const conn = db.get();
  const outdated = { status: 'outdated', app: 'Datum Gateway (BLAKE2b)', store: { url: gateway.REGISTRY_URL } };
  alerts.evaluate(conn, { rentals: [], fetch_ok: {}, gateway: outdated }, {}, 1000);
  const row = conn.prepare("SELECT key, algo FROM alerts WHERE kind = 'gateway_outdated'").get();
  assert.equal(row.key, market.activeAlgo(conn));
  assert.equal(row.algo, market.activeAlgo(conn));
});

test('a dismissed alert stays dismissed while the gateway is unchanged, and clears when it is fixed', () => {
  const conn = db.get();
  const base = { rentals: [], fetch_ok: {} };
  const outdated = { status: 'outdated', app: 'Datum Gateway (BLAKE2b)', store: { url: gateway.REGISTRY_URL } };
  alerts.evaluate(conn, { ...base, gateway: outdated }, {}, 1000);
  const id = conn.prepare("SELECT id FROM alerts WHERE kind = 'gateway_outdated' AND state = 'fired'").get().id;
  alerts.ack(conn, id, 1500);
  alerts.evaluate(conn, { ...base, gateway: outdated }, {}, 2000);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'gateway_outdated' AND state = 'fired'").get().n, 0, 'not re-raised');
  alerts.evaluate(conn, { ...base, gateway: { ...outdated, status: 'ready' } }, {}, 3000);
  assert.equal(conn.prepare("SELECT state FROM alerts WHERE id = ?").get(id).state, 'resolved');
  // A later regression raises it afresh.
  alerts.evaluate(conn, { ...base, gateway: outdated }, {}, 4000);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'gateway_outdated' AND state = 'fired'").get().n, 1);
});

test('a result recorded for another host is not shown once the endpoint has moved', async () => {
  const conn = db.get();
  conn.prepare("INSERT INTO pool_endpoints (algo, host, port, worker_base, active, gateway_json) VALUES (?, '127.0.0.1', 1, 'bc1qx.w', 1, ?)")
    .run(market.activeAlgo(conn), JSON.stringify({ status: 'outdated', endpoint: 'old.example:1' }));
  const t0 = 1_700_000_000_000;
  const out = await observe.observe(conn, client(), { now: t0, marketSkip: true, probeTimeoutMs: 300, prevState: { rentals: {}, marketAt: t0, refundAt: t0 } });
  assert.equal(out.snapshot.gateway, null);
});

test('a dismissed alert is shown again when what to do changes (install it -> switch it on)', () => {
  const conn = db.get();
  const base = { rentals: [], fetch_ok: {} };
  const outdated = { status: 'outdated', app: 'Datum Gateway (BLAKE2b)', store: { url: gateway.REGISTRY_URL } };
  alerts.evaluate(conn, { ...base, gateway: outdated }, {}, 1000);
  const id = conn.prepare("SELECT id FROM alerts WHERE kind = 'gateway_outdated' AND state = 'fired'").get().id;
  alerts.ack(conn, id, 1500);
  alerts.evaluate(conn, { ...base, gateway: { ...outdated, status: 'disabled' } }, {}, 2000);
  const fired = conn.prepare("SELECT context_json FROM alerts WHERE kind = 'gateway_outdated' AND state = 'fired'").get();
  assert.ok(fired, 'raised again');
  assert.equal(JSON.parse(fired.context_json).status, 'disabled');
});

test('a result recorded for another algorithm is ignored for this tick', () => {
  const conn = db.get();
  const other = market.activeAlgo(conn) === 'blake2b' ? 'sha256ab' : 'blake2b';
  const ev = alerts.evaluate(conn, { rentals: [], fetch_ok: {}, gateway: { status: 'outdated', algo: other } }, {}, 1000);
  assert.equal(ev.filter((e) => e.kind === 'gateway_outdated').length, 0);
});

test('a last-known result older than a day is not kept', async () => {
  const conn = db.get();
  const t0 = 1_700_000_000_000;
  conn.prepare("INSERT INTO pool_endpoints (algo, host, port, worker_base, active, gateway_json) VALUES (?, '127.0.0.1', 1, 'bc1qx.w', 1, ?)")
    .run(market.activeAlgo(conn), JSON.stringify({ status: 'outdated', endpoint: '127.0.0.1:1', checked_at: Math.floor(t0 / 1000) - 2 * 86400 }));
  const out = await observe.observe(conn, client(), { now: t0, marketSkip: true, probeTimeoutMs: 300, prevState: { rentals: {}, marketAt: t0, refundAt: t0 } });
  assert.equal(out.snapshot.gateway, null);
});
