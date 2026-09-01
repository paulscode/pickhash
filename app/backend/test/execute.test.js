'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { execute } = require('../engine/execute');
const { MrrApiError, MrrAmbiguousError } = require('../mrr-client');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-exec-'));
const endpoint = { host: 'ab.gg', port: 26596, worker_base: 'bc1qx.phash', mrr_profile_id: 953073 };

function mockClient(opts = {}) {
  const state = { puts: [], nextId: 7_000_000 };
  return {
    state,
    async put(p, params) {
      state.puts.push([p, params]);
      if (p === '/rental') {
        if (opts.rentFail === 'ambiguous') throw new MrrAmbiguousError('timeout on create');
        if (opts.rentFail === 'clean') throw new MrrApiError('rig taken');
        if (opts.noId) return { ok: true };   // resolves with no usable id
        return { id: String(state.nextId++), start_unix: 1000, end_unix: 1000 + 3 * 3600 };
      }
      if (/^\/rental\/\d+\/pool\/0$/.test(p)) return { message: 'ok' };
      if (/^\/rental\/\d+\/pool\/1$/.test(p)) {
        if (opts.poolOneFail) throw new MrrApiError('pool 1 rejected');
        return { message: 'ok' };
      }
      throw new Error('unexpected put ' + p);
    },
  };
}

function action(id, over = {}) {
  return {
    type: 'TOPUP_RENT', rigId: String(id), rigName: `rig-${id}`, region: 'us', advertisedTh: 100,
    lengthHours: 3, rateCapUnitDay: 0.000505, paidSats: 60_000, feeSats: 1_800,
    rateBtcThDay: 0.0000005, endpointDiff: 131072, optimalDiffMin: 1000, optimalDiffMax: 2_000_000, diffInRange: 1, ...over,
  };
}

let sessionId;
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  c.prepare('DELETE FROM rentals').run();
  c.prepare('DELETE FROM decisions').run();
  c.prepare('DELETE FROM sessions').run();
  c.prepare('DELETE FROM alerts').run();
  c.prepare('DELETE FROM spend_events').run();
  sessionId = Number(c.prepare(
    "INSERT INTO sessions (mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at) VALUES ('autopilot','active',300,1000000,168,0,0,1000,1000)",
  ).run().lastInsertRowid);
});

test('a DRY-RUN would-do records a decision and mutates nothing', async () => {
  const client = mockClient();
  const r = await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [], wouldDo: [action(1)] } });
  assert.equal(r.rehearsed.length, 1);
  assert.equal(client.state.puts.length, 0, 'no MRR calls in a rehearsal');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
  assert.match(db.get().prepare("SELECT note FROM decisions WHERE note LIKE 'AUTOPILOT DRY-RUN%'").get().note, /would rent rig #1/);
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId).spent_sats, 0, 'no spend');
});

test('a LIVE authorized rent creates the rental + worker override + decision and advances spent', async () => {
  const client = mockClient();
  const r = await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
  assert.equal(r.executed.length, 1);
  const row = db.get().prepare('SELECT * FROM rentals WHERE session_id = ?').get(sessionId);
  assert.ok(row.mrr_id > 0 && /^bc1qx\.phash-r\d+$/.test(row.worker_name) && row.health === 'pending');
  assert.equal(row.endpoint_diff, 131072, 'diff telemetry persisted like a quick rental');
  assert.equal(client.state.puts.filter((p) => p[0] === '/rental').length, 1);
  assert.equal(client.state.puts.filter((p) => /\/pool\/0$/.test(p[0])).length, 1, 'per-rental worker override applied');
  const s = db.get().prepare('SELECT spent_sats, fee_sats FROM sessions WHERE id = ?').get(sessionId);
  assert.equal(s.spent_sats, 61_800, 'spent advanced by the fee-inclusive cost (gate sees it next tick)');
  assert.equal(s.fee_sats, 1_800);
});

test('autopilot honors the Ocean fallback: attaches pool/1 (same address, .fallback tag) and records fallback=ocean', async () => {
  // Regression: the fallback was wired only into the manual rent path — autopilot (which creates
  // nearly all rentals) called rentOne without it, so Ocean never actually attached. Default is ON.
  const client = mockClient();
  await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
  const poolOne = client.state.puts.filter((p) => /\/pool\/1$/.test(p[0]));
  assert.equal(poolOne.length, 1, 'Ocean attached at priority 1');
  assert.equal(poolOne[0][1].host, 'bip110.mine.ocean.xyz');
  assert.equal(poolOne[0][1].port, 3110);
  assert.equal(poolOne[0][1].priority, 1);
  assert.equal(poolOne[0][1].user, 'bc1qx.fallback', 'same BTC address with the .fallback worker tag');
  assert.match(db.get().prepare("SELECT note FROM decisions WHERE note LIKE 'autopilot rented%'").get().note, /fallback ocean/);
});

test('autopilot skips the Ocean fallback when disabled: no pool/1 attach', async () => {
  config.set(db.get(), 'strategy', { fallback_pool_enabled: false });
  try {
    const client = mockClient();
    await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
    assert.equal(client.state.puts.filter((p) => /\/pool\/1$/.test(p[0])).length, 0, 'no Ocean attach when off');
    assert.match(db.get().prepare("SELECT note FROM decisions WHERE note LIKE 'autopilot rented%'").get().note, /fallback off/);
  } finally {
    config.set(db.get(), 'strategy', { fallback_pool_enabled: true });
  }
});

test('a failed Ocean pool/1 attach is best-effort: the rental still succeeds (fallback=ocean_failed)', async () => {
  const client = mockClient({ poolOneFail: true });
  const r = await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
  assert.equal(r.executed.length, 1, 'the rental is not failed over a best-effort fallback attach');
  assert.ok(db.get().prepare('SELECT 1 FROM rentals WHERE session_id = ?').get(sessionId), 'rental persisted');
  assert.match(db.get().prepare("SELECT note FROM decisions WHERE note LIKE 'autopilot rented%'").get().note, /fallback ocean_failed/);
});

test('an ambiguous create fires needs_reconcile, halts, persists no rental, and never retries', async () => {
  const client = mockClient({ rentFail: 'ambiguous' });
  const r = await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1), action(2)], wouldDo: [] } });
  assert.equal(r.halted, true);
  assert.equal(r.haltReason, 'ambiguous');
  assert.equal(client.state.puts.filter((p) => p[0] === '/rental').length, 1, 'one attempt, no retry, second not tried');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'no rental persisted on an unknown outcome');
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'needs_reconcile' AND state = 'fired'").get(), 'orphan surfaced for reconciliation');
});

test('a clean failure is recorded and does NOT halt (the next rig is still attempted)', async () => {
  const client = mockClient({ rentFail: 'clean' });
  const r = await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1), action(2)], wouldDo: [] } });
  assert.equal(r.halted, false);
  assert.equal(client.state.puts.filter((p) => p[0] === '/rental').length, 2, 'both attempted');
  assert.equal(r.executed.length, 0);
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM decisions WHERE note LIKE 'autopilot rig_failed%'").get().n, 2);
});

test('a create that resolves without a usable id is treated as ambiguous (no NaN rental)', async () => {
  const client = mockClient({ noId: true });
  const r = await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
  assert.equal(r.halted, true);
  assert.equal(r.haltReason, 'ambiguous', 'a no-usable-id outcome halts as ambiguous');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'needs_reconcile' AND state = 'fired'").get(), 'orphan surfaced for reconciliation (parity with the true-ambiguous path)');
});

test('a LIVE rent writes a spend_events ledger row (kind rent, fee-inclusive sats)', async () => {
  const client = mockClient();
  await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
  const rental = db.get().prepare('SELECT mrr_id FROM rentals WHERE session_id = ?').get(sessionId);
  const ev = db.get().prepare("SELECT * FROM spend_events WHERE kind = 'rent'").get();
  assert.ok(ev, 'persistRental wrote a rent spend_event');
  assert.equal(ev.sats, 61_800, 'fee-inclusive paid + fee');
  assert.equal(ev.session_id, sessionId);
  assert.equal(ev.mrr_id, rental.mrr_id, 'ledger row keyed to the created rental');
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM spend_events WHERE kind = 'rent'").get().n, 1, 'exactly one rent event');
});

test('a DRY-RUN rehearsal writes no spend_events row', async () => {
  const client = mockClient();
  await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [], wouldDo: [action(1)] } });
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM spend_events').get().n, 0, 'a rehearsal spends nothing');
});

test('the intent decision (autopilot intent) is written before the rental row', async () => {
  const client = mockClient();
  await execute(db.get(), client, { sessionId, endpoint, gateResult: { authorized: [action(1)], wouldDo: [] } });
  const intent = db.get().prepare("SELECT id FROM decisions WHERE note = 'autopilot intent'").get();
  const rented = db.get().prepare("SELECT id FROM decisions WHERE note LIKE 'autopilot rented%'").get();
  assert.ok(intent, 'intent-first audit row written (the reconcile anchor)');
  assert.ok(rented && intent.id < rented.id, 'intent precedes the rented decision');
  assert.ok(db.get().prepare('SELECT 1 FROM rentals WHERE session_id = ?').get(sessionId), 'rental persisted after the intent');
});
