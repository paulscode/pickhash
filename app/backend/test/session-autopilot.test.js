'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const session = require('../session');
const config = require('../config');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-apstart-'));

// A stable, autopilot-eligible raw rig (measured == advertised).
function rawRig(id, phAdvertised = 0.1, hourBtc = 0.0002) {
  const mh = String(phAdvertised * 1e9);
  return {
    id: String(id), name: `rig-${id}`, owner: `o${id}`, type: 'sha256ab',
    status: { status: 'available', rented: false, online: true }, online: true,
    poolstatus: 'online', region: 'us', rpi: '95.00',
    optimal_diff: { min: '1000', max: '2000000' }, extensions: true,
    price: { type: 'ph', BTC: { currency: 'BTC', price: '0.00050000', hour: String(hourBtc), min_rental_length: 3, enabled: true } },
    minhours: '3', maxhours: '96',
    hashrate: {
      advertised: { hash: String(phAdvertised), type: 'ph' },
      last_5min: { hash: mh, type: 'mh' }, last_15min: { hash: mh, type: 'mh' }, last_30min: { hash: mh, type: 'mh' },
    },
    available_status: 'available',
  };
}

function client(rigs = [rawRig(1), rawRig(2), rawRig(3)]) {
  return {
    async get(p, params) {
      if (p === '/rig') return (params && params.offset > 0) ? { records: [], total: rigs.length } : { records: rigs, total: rigs.length, offset: 0, count: rigs.length };
      if (p === '/account/balance') return { BTC: { confirmed: '0.01', unconfirmed: '0' } };
      throw new Error('unexpected get ' + p);
    },
  };
}

before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  c.prepare('DELETE FROM rentals').run();
  c.prepare('DELETE FROM sessions').run();
  c.prepare('DELETE FROM pool_endpoints').run();
  c.prepare('DELETE FROM config').run();
  c.prepare('INSERT INTO pool_endpoints (host, port, worker_base, stratum_diff, mrr_pool_id, mrr_profile_id, active) VALUES (?,?,?,?,?,?,1)')
    .run('ab.gg', 26596, 'bc1qx.phash', 131072, 111, 953073);
});

test('opens an autopilot session (row + feasibility estimate) and creates NO rentals', async () => {
  const r = await session.startAutopilotSession(db.get(), client(), { targetTh: 300, timeCapHours: 168, budgetSats: 1_000_000 });
  assert.ok(r.session_id > 0);
  assert.equal(r.mode, 'autopilot');
  const row = db.get().prepare('SELECT * FROM sessions WHERE id = ?').get(r.session_id);
  assert.equal(row.mode, 'autopilot');
  assert.equal(row.state, 'active');
  assert.equal(row.target_th, 300);
  assert.equal(row.time_cap_hours, 168);
  assert.equal(row.spent_sats, 0);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'no synchronous rentals — the loop fills it');
  // Estimate: 3 rigs cover the 300 TH target, with a positive burn + runway projection.
  assert.equal(r.estimate.rigCount, 3);
  assert.equal(r.estimate.coveredTh, 300);
  assert.ok(r.estimate.burnSatsHr > 0 && r.estimate.runwayHours > 0);
});

test('estimate does not over-provision a small target when only oversized rigs exist (and still starts)', async () => {
  // Market has only 1 PH (1000 TH) rigs; target is 200 TH. The bounded packer must NOT "hold" 200
  // with a giant rig (the old greedy did, reporting ~1000+ TH and ~6x burn). Expect a 0-cover
  // estimate with a shortfall — but the session STILL opens, because eligible rigs exist and the
  // live decide loop fills the gap as fitting rigs appear.
  const big = [rawRig('b1', 1, 0.002), rawRig('b2', 1, 0.002)];
  const r = await session.startAutopilotSession(db.get(), client(big), { targetTh: 200, timeCapHours: 24, budgetSats: 1_000_000 });
  assert.ok(r.session_id > 0, 'session opens');
  assert.equal(r.estimate.rigCount, 0, 'no giant rig rented to hold a small target');
  assert.equal(r.estimate.coveredTh, 0);
  assert.equal(r.estimate.shortfallTh, 200);
  assert.ok(r.estimate.eligibleRigs >= 2, 'eligible rigs exist -> session is allowed');
});

test('refuses to open a second session while one is active', async () => {
  await session.startAutopilotSession(db.get(), client(), { targetTh: 100, timeCapHours: 24, budgetSats: 500_000 });
  await assert.rejects(
    () => session.startAutopilotSession(db.get(), client(), { targetTh: 100, timeCapHours: 24, budgetSats: 500_000 }),
    (e) => e instanceof session.SessionError && e.code === 'session_active',
  );
});

test('validates target / time cap / budget', async () => {
  const c = client();
  for (const [params, code] of [
    [{ targetTh: 0, timeCapHours: 24, budgetSats: 100000 }, 'bad_target'],
    [{ targetTh: 100, timeCapHours: 0, budgetSats: 100000 }, 'bad_time_cap'],
    [{ targetTh: 100, timeCapHours: 24, budgetSats: 0 }, 'bad_budget'],
  ]) {
    await assert.rejects(() => session.startAutopilotSession(db.get(), c, params), (e) => e.code === code);
  }
});

test('a budget above the global guardrail is rejected', async () => {
  // Default max_session_budget_sats is 5,000,000.
  await assert.rejects(
    () => session.startAutopilotSession(db.get(), client(), { targetTh: 100, timeCapHours: 24, budgetSats: 6_000_000 }),
    (e) => e.code === 'exceeds_guardrail',
  );
});

test('no configured pool endpoint is rejected', async () => {
  db.get().prepare('DELETE FROM pool_endpoints').run();
  await assert.rejects(
    () => session.startAutopilotSession(db.get(), client(), { targetTh: 100, timeCapHours: 24, budgetSats: 500_000 }),
    (e) => e.code === 'no_endpoint',
  );
});

test('an empty market (no eligible rigs) is rejected', async () => {
  await assert.rejects(
    () => session.startAutopilotSession(db.get(), client([]), { targetTh: 100, timeCapHours: 24, budgetSats: 500_000 }),
    (e) => e.code === 'no_rigs_available',
  );
});

// ---- stopSession ----

function seedSession(state, rentalSpecs = []) {
  const c = db.get();
  const sid = Number(c.prepare(
    'INSERT INTO sessions (mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('autopilot', state, 200, 50_000, 168, 0, 0, 1, 1).lastInsertRowid);
  for (const r of rentalSpecs) {
    c.prepare('INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (?,?,1,?,100,3,1000,30,1,999,?,?,?)')
      .run(sid, r.mrr_id, 'r', r.ended ? 1 : 0, r.health || 'healthy', 'w');
  }
  return sid;
}

test('stopSession ENDS a session with no live rentals (e.g. a DRY-RUN autopilot with 0 rentals)', async () => {
  const sid = seedSession('active');
  const r = await session.stopSession(db.get());
  assert.equal(r.stopped, true);
  assert.equal(r.state, 'ended');
  assert.equal(db.get().prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'ended');
});

test('stopSession WINDS DOWN a session that still has a paid rental running', async () => {
  const sid = seedSession('active', [{ mrr_id: 999, ended: false }]);
  const r = await session.stopSession(db.get());
  assert.equal(r.state, 'winding_down');
  assert.equal(r.active_rentals, 1);
  assert.equal(db.get().prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'winding_down');
});

test('stopSession reports nothing to stop when no session is active', async () => {
  const r = await session.stopSession(db.get());
  assert.equal(r.stopped, false);
  assert.equal(r.reason, 'no_active_session');
});

test('stopSession reconciles the immediate close against the ledger when a client is given', async () => {
  // An ended rental recorded at 1030 sats, but MRR's ledger says 1545 (1500 + 45).
  const sid = seedSession('active', [{ mrr_id: 9000001, ended: true }]);
  db.get().prepare('UPDATE rentals SET paid_sats = 1000, fee_sats = 30 WHERE mrr_id = 9000001').run();
  const client = {
    async get(path) {
      if (path === '/account/transactions') return { transactions: [
        { id: '1', type: 'Payment', amount: -0.0000150, rental: '9000001' },
        { id: '2', type: 'Rental Fee', amount: -4.5e-7, rental: '9000001' },
      ] };
      throw new Error('unexpected ' + path);
    },
  };
  const r = await session.stopSession(db.get(), client);
  assert.equal(r.state, 'ended');
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sid).spent_sats, 1545,
    'closed with the ledger-reconciled gross, not the recorded 1030');
});

test('a new session is blocked while a stopped session is still winding down', async () => {
  seedSession('winding_down', [{ mrr_id: 999, ended: false }]);
  await assert.rejects(
    () => session.startAutopilotSession(db.get(), client(), { targetTh: 100, timeCapHours: 24, budgetSats: 500_000 }),
    (e) => e.code === 'session_active',
  );
});
