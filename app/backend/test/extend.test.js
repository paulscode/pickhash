'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const extend = require('../engine/extend');
const config = require('../config');

// ---- planExtend (pure) ----

const rental = { paid_sats: 60_000, fee_sats: 1_800, length_hours: 3 };   // original 61,800/3 = 20,600 sats/hr
const sim = (over = {}) => ({ cost: 61_800, current_hrs: 3, new_hrs: 6, maxhrs: 96, ...over });

test('planExtend: extends when the price is in line and budget/window allow', () => {
  const p = extend.planExtend({ rental, sim: sim(), tolerancePct: 10, budgetRemainingSats: 1_000_000, windowRemainingH: 100 });
  assert.deepEqual(p, { extend: true, lengthHours: 3, costSats: 61_800 });
});

test('planExtend: declines when the extension rate jumped beyond tolerance', () => {
  const p = extend.planExtend({ rental, sim: sim({ cost: 90_000 }), tolerancePct: 10, budgetRemainingSats: 1_000_000, windowRemainingH: 100 });
  assert.deepEqual(p, { extend: false, reason: 'price_jumped' });
});

test('planExtend: declines over budget, over the time cap, or over maxhours', () => {
  assert.equal(extend.planExtend({ rental, sim: sim(), tolerancePct: 10, budgetRemainingSats: 10_000, windowRemainingH: 100 }).reason, 'over_budget');
  assert.equal(extend.planExtend({ rental, sim: sim(), tolerancePct: 10, budgetRemainingSats: 1e9, windowRemainingH: 1 }).reason, 'over_time_cap');
  // cost scales with the (large) extension length so it isn't flagged as a units error.
  assert.equal(extend.planExtend({ rental, sim: sim({ new_hrs: 99, maxhrs: 96, cost: 20_600 * 96 }), tolerancePct: 10, budgetRemainingSats: 1e9, windowRemainingH: 200 }).reason, 'over_maxhours');
});

test('planExtend: declines a non-extendable / missing simulation', () => {
  assert.equal(extend.planExtend({ rental, sim: null, tolerancePct: 10, budgetRemainingSats: 1e9, windowRemainingH: 100 }).reason, 'no_sim');
  assert.equal(extend.planExtend({ rental, sim: sim({ cost: 0 }), tolerancePct: 10, budgetRemainingSats: 1e9, windowRemainingH: 100 }).reason, 'not_extendable');
});

test('planExtend: declines when the original rate is unknown (length_hours <= 0) rather than extending blind', () => {
  const noLen = { paid_sats: 60_000, fee_sats: 1_800, length_hours: 0 };
  assert.equal(extend.planExtend({ rental: noLen, sim: sim(), tolerancePct: 10, budgetRemainingSats: 1e9, windowRemainingH: 100 }).reason, 'unknown_original_rate');
});

test('planExtend: price guard EXACT boundary using the DEFAULT 10% tolerance', () => {
  // orig hourly = 61,800 / 3 = 20,600; threshold = 20,600 * 1.1 = 22,660 sats/hr over a 3h extension.
  const atThreshold = extend.planExtend({ rental, sim: sim({ cost: 67_980 }), budgetRemainingSats: 1e9, windowRemainingH: 100 });
  assert.deepEqual(atThreshold, { extend: true, lengthHours: 3, costSats: 67_980 }, 'a cost exactly at the tolerance still extends (tolerancePct omitted -> 10%)');
  const oneOver = extend.planExtend({ rental, sim: sim({ cost: 67_981 }), budgetRemainingSats: 1e9, windowRemainingH: 100 });
  assert.equal(oneOver.reason, 'price_jumped', 'one sat over the tolerance declines');
});

test('planExtend: not_extendable when new_hrs <= current_hrs despite a positive cost', () => {
  const p = extend.planExtend({ rental, sim: sim({ new_hrs: 3, current_hrs: 3, cost: 61_800 }), budgetRemainingSats: 1e9, windowRemainingH: 100 });
  assert.equal(p.reason, 'not_extendable');
});

// ---- runAutoExtend (impure) ----

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-extend-'));
const NOW_SEC = 2_000_000;
const NOW_MS = NOW_SEC * 1000;
let sessionId;

before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  for (const t of ['rentals', 'decisions', 'sessions', 'alerts', 'spend_events']) c.prepare(`DELETE FROM ${t}`).run();
  c.prepare('DELETE FROM config').run();
  config.set(c, 'strategy', { auto_extend: true });
  sessionId = Number(c.prepare(
    "INSERT INTO sessions (mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at) VALUES ('autopilot','active',300,1000000,168,0,0,?,?)",
  ).run(NOW_SEC - 3600, NOW_SEC - 3600).lastInsertRowid);
  // A healthy rental ending in 10 minutes.
  c.prepare('INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)')
    .run(sessionId, 700, 42, 'GoodRig', 100, 3, 60_000, 1_800, 1000, NOW_SEC + 600, 'healthy', 'w');
});

function mockClient(simResp) {
  const state = { puts: [] };
  return {
    state,
    async put(p, params) {
      state.puts.push([p, params]);
      if (/\/extend$/.test(p)) return params.getcost ? simResp : { success: true };
      throw new Error('unexpected put ' + p);
    },
  };
}
const okSnap = { endpoint: { ok: true } };

test('runAutoExtend: no-op when auto_extend is disabled', async () => {
  config.set(db.get(), 'strategy', { auto_extend: false });
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'disabled');
});

test('runAutoExtend: skips when the endpoint is unhealthy', async () => {
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), { endpoint: { ok: false } }, { now: NOW_MS });
  assert.equal(r.reason, 'endpoint_unhealthy');
});

test('runAutoExtend LIVE: extends the rental, advances end_ts + spend, marks it, alerts', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = mockClient(sim());
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'extended');
  const row = db.get().prepare('SELECT length_hours, end_ts, paid_sats, fee_sats FROM rentals WHERE mrr_id = 700').get();
  assert.equal(row.length_hours, 6, '3h -> 6h');
  assert.equal(row.end_ts, NOW_SEC + 600 + 3 * 3600, 'end advanced by the extension');
  assert.equal(row.paid_sats, 120_000);   // 60000 + round(61800/1.03)=60000
  assert.equal(row.fee_sats, 3_600);      // 1800 + 1800
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId).spent_sats, 61_800);
  assert.equal(client.state.puts.filter((p) => /\/extend$/.test(p[0]) && !p[1].getcost).length, 1, 'exactly one real extend call');
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'rental_extended'").get());
  // The sim numbers ride along on the success path too (return value + executed_json).
  assert.deepEqual(r.sim, { maxhrs: 96, current_hrs: 3, new_hrs: 6, cost_raw: 61_800 });
  assert.deepEqual(JSON.parse(db.get().prepare("SELECT executed_json FROM decisions WHERE note LIKE 'auto_extend:700:extended:%'").get().executed_json),
    { maxhrs: 96, current_hrs: 3, new_hrs: 6, cost_raw: 61_800 });
});

test('runAutoExtend DRY-RUN: rehearses (no extend, no spend) and records a would-extend', async () => {
  const client = mockClient(sim());   // run mode defaults to dry-run
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'would_extend');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'unchanged');
  assert.equal(client.state.puts.filter((p) => !p[1].getcost).length, 0, 'no real extend in DRY-RUN');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note LIKE 'auto_extend:700:dry_run%'").get());
});

test('runAutoExtend LIVE: records a dated spend_event (so the daily cap + pacing see it)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  const ev = db.get().prepare("SELECT ts, sats, kind, mrr_id FROM spend_events WHERE kind = 'extend'").get();
  assert.ok(ev, 'a spend_event row was written for the extension');
  assert.equal(ev.sats, 61_800);
  assert.equal(ev.mrr_id, 700);
});

test('runAutoExtend: paused while a needs_reconcile orphan is outstanding', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  require('../alerts').fireOnce(db.get(), { kind: 'needs_reconcile', key: 'mrr9', now: Date.now() });
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.equal(r.reason, 'needs_reconcile');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'no extension while halted');
});

test('runAutoExtend: a candidate whose getcost keeps failing does not starve the others', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const start = 1_700_000_000;
  // A second healthy near-end rental (701) after 700 in end-order; 700's sim always throws.
  db.get().prepare('INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)')
    .run(sessionId, 701, 43, 'GoodRig2', 100, 3, 60_000, 1_800, start, NOW_SEC + 900, 'healthy', 'w');
  const client = {
    state: { puts: [] },
    async put(p, params) {
      this.state.puts.push([p, params]);
      if (/\/rental\/700\/extend$/.test(p)) throw new Error('rig delisted');   // 700 always fails
      if (/\/extend$/.test(p)) return params.getcost ? sim() : { success: true };
      throw new Error('unexpected ' + p);
    },
  };
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'extended');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 701').get().length_hours, 6, '701 was reached and extended despite 700 failing');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, '700 untouched');
});

test('runAutoExtend: a price jump is declined and not re-attempted next tick', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = mockClient(sim({ cost: 120_000 }));   // rate roughly doubled
  const r1 = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r1.decided, 'price_jumped');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'not extended');
  // Second tick: the decision marker makes it skip (no re-simulate).
  const before = client.state.puts.length;
  const r2 = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS + 60_000 });
  assert.equal(r2.reason, 'no_candidate');
  assert.equal(client.state.puts.length, before, 'no further MRR calls for an already-attempted rental');
});

test('runAutoExtend: the attempt marker EXPIRES past EXTEND_RETRY_SEC so the same rental is re-evaluated', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  // Push end_ts out so the rental is still near-end 601s later (it would otherwise have ended).
  db.get().prepare('UPDATE rentals SET end_ts = ? WHERE mrr_id = 700').run(NOW_SEC + 1200);
  const client = mockClient(sim({ cost: 120_000 }));   // price jump -> declined + marker, no mutation
  const r1 = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r1.decided, 'price_jumped');
  const afterFirst = client.state.puts.length;
  assert.ok(afterFirst > 0, 'first tick simulated');
  // 601s later: past EXTEND_RETRY_SEC (600) -> the marker window has expired -> re-simulate, not skip.
  const r2 = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS + 601_000 });
  assert.equal(r2.decided, 'price_jumped', 'the SAME rental is re-evaluated once the retry window lapses');
  assert.ok(client.state.puts.length > afterFirst, 'getcost was re-issued (not short-circuited by the stale marker)');
});

test('runAutoExtend LIVE: pacing blocks with reason paced and writes NO marker (so it retries next tick)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  config.set(db.get(), 'strategy', { auto_extend: true, rent_pacing_seconds: 300 });
  // A rent 10s ago -> lastRentAt is inside the pacing interval, so the gate paces this extension.
  db.get().prepare("INSERT INTO spend_events (ts, sats, kind, session_id, mrr_id) VALUES (?, 1000, 'rent', ?, 700)").run(NOW_SEC - 10, sessionId);
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.deepEqual(r, { ran: false, reason: 'paced' });
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM decisions WHERE note LIKE 'auto_extend:%'").get().n, 0, 'no decisions marker so the next tick re-tries');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'not extended');
});

test('runAutoExtend: guards — a null client and no active autopilot session', async () => {
  assert.deepEqual(await extend.runAutoExtend(db.get(), null, okSnap, { now: NOW_MS }), { ran: false, reason: 'no_client' });
  db.get().prepare("UPDATE sessions SET state = 'winding_down' WHERE id = ?").run(sessionId);
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.deepEqual(r, { ran: false, reason: 'no_autopilot_session' });
});

test('runAutoExtend: a non-pacing gate block (max daily spend) records a declined marker and returns the reason', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  config.set(db.get(), 'guardrails', { max_daily_spend_sats: 1_000 });   // below the extension's cost
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.equal(r.ran, true);
  assert.equal(r.decided, 'max_daily_spend');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'auto_extend:700:declined:max_daily_spend'").get(), 'a declined marker was recorded');
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'not extended');
});

test('runAutoExtend LIVE: a transient real-extend PUT failure continues to the next candidate without mutating', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  const client = {
    state: { puts: [] },
    async put(p, params) {
      this.state.puts.push([p, params]);
      if (/\/extend$/.test(p) && params.getcost) return sim();          // sim succeeds
      if (/\/extend$/.test(p)) throw new Error('MRR 503 on real extend');   // the real extend fails transiently
      throw new Error('unexpected ' + p);
    },
  };
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.deepEqual(r, { ran: false, reason: 'no_extendable_candidate' });
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'rental unchanged');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM spend_events').get().n, 0, 'no spend recorded');
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM decisions WHERE note LIKE 'auto_extend:%'").get().n, 0, 'no marker written on a transient failure');
});

test('runAutoExtend: no remaining time window records a declined:no_window', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  // Session started well past its time cap -> windowRemainingH <= 0 -> askHours <= 0.
  db.get().prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(NOW_SEC - 200 * 3600, sessionId);
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'no_window');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'auto_extend:700:declined:no_window'").get());
  assert.equal(db.get().prepare('SELECT length_hours FROM rentals WHERE mrr_id = 700').get().length_hours, 3, 'not extended');
});

test('runAutoExtend LIVE: an ambiguous PUT whose detail is ALSO unreachable halts (compound failure) — no mutation', async () => {
  const { MrrAmbiguousError } = require('../mrr-client');
  config.set(db.get(), 'run', { mode: 'live' });
  // getcost sim succeeds, the REAL extend PUT is ambiguous, AND the reconciling detail GET also
  // fails -> we genuinely can't tell if it extended, so halt (never silently re-extend).
  const client = {
    async put(p, params) {
      if (params && params.getcost) return sim();
      throw new MrrAmbiguousError('extend timed out');
    },
    async get() { throw new MrrAmbiguousError('detail unreachable too'); },
  };
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'ambiguous_extend');
  const row = db.get().prepare('SELECT end_ts, paid_sats, fee_sats, length_hours FROM rentals WHERE mrr_id = 700').get();
  assert.equal(row.end_ts, NOW_SEC + 600, 'end_ts not advanced on an unconfirmed extend');
  assert.equal(row.paid_sats, 60_000, 'paid_sats not advanced');
  assert.equal(row.length_hours, 3, 'length not advanced');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM spend_events').get().n, 0, 'no spend recorded for an unconfirmed extend (no under-count)');
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind='needs_reconcile'").get(), 'a reconcile halt is raised');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'auto_extend:700:ambiguous_extend'").get(), 'marked so attempted() skips it next tick (no immediate re-extend)');
});

test('runAutoExtend records the getcost sim numbers in executed_json on a decline (note contract unchanged)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  // not_extendable: new_hrs == current_hrs (rig at its max length). Capture maxhrs/current/new/cost.
  const client = mockClient(sim({ new_hrs: 3, current_hrs: 3, maxhrs: 3, cost: 61_800 }));
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'not_extendable');
  assert.deepEqual(r.sim, { maxhrs: 3, current_hrs: 3, new_hrs: 3, cost_raw: 61_800 }, 'sim summary flows to the engine log');
  const row = db.get().prepare("SELECT note, executed_json FROM decisions WHERE note LIKE 'auto_extend:700:declined:%'").get();
  assert.equal(row.note, 'auto_extend:700:declined:not_extendable', 'note string unchanged (stable contract)');
  assert.deepEqual(JSON.parse(row.executed_json), { maxhrs: 3, current_hrs: 3, new_hrs: 3, cost_raw: 61_800 },
    'the raw sim numbers are durably recorded for diagnosis (maxhrs == current_hrs -> rig at max)');
});

test('runAutoExtend leaves the final replace-lead window to the top-up (a rig ending within it is not extended)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  // 2 min to end, inside the default 5-min replace lead -> the replacement handles it, not extend.
  db.get().prepare('UPDATE rentals SET end_ts = ? WHERE mrr_id = 700').run(NOW_SEC + 120);
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.equal(r.reason, 'no_candidate', 'a rig inside the replace-lead window is excluded from extend');
});

test('extend/replace boundary is complementary: exactly at the lead is excluded, one second past is a candidate', async () => {
  const lead = 300;   // replace_lead_minutes default 5 * 60 (dry-run: no mutation, just probe the boundary)
  db.get().prepare('UPDATE rentals SET end_ts = ? WHERE mrr_id = 700').run(NOW_SEC + lead);
  assert.equal((await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS })).reason, 'no_candidate',
    'end - now == lead -> decide owns it (extend excludes), matching contributionTh discounting at <= lead');
  db.get().prepare('UPDATE rentals SET end_ts = ? WHERE mrr_id = 700').run(NOW_SEC + lead + 1);
  assert.notEqual((await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS })).reason, 'no_candidate',
    'end - now == lead+1 -> extend owns it (decide counts it full)');
});

test('runAutoExtend LIVE: an ambiguous PUT that ACTUALLY extended is reconciled from detail (records the real delta, no halt)', async () => {
  const { MrrAmbiguousError } = require('../mrr-client');
  config.set(db.get(), 'run', { mode: 'live' });
  // Real extend PUT is ambiguous, but the authoritative detail shows a total charge of 80,000 sats
  // vs our recorded 61,800 -> the extension DID apply; record the 18,200-sat delta.
  const client = {
    async put(p, params) {
      if (params && params.getcost) return sim();
      throw new MrrAmbiguousError('extend timed out');
    },
    async get(p) { return { price: { paid: 0.0008 } }; },   // 80,000 sats total
  };
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'extended_reconciled');
  const row = db.get().prepare('SELECT end_ts, length_hours, paid_sats, fee_sats FROM rentals WHERE mrr_id = 700').get();
  assert.equal(row.end_ts, NOW_SEC + 600 + 3 * 3600, 'end advanced by the 3h extension');
  assert.equal(row.length_hours, 6);
  assert.equal(row.paid_sats + row.fee_sats, 61_800 + 18_200, 'the ACTUAL 18,200-sat delta recorded');
  const ev = db.get().prepare("SELECT sats FROM spend_events WHERE kind = 'extend'").get();
  assert.equal(ev.sats, 18_200, 'spend_events records the real charge, keeping the budget accurate');
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sessionId).spent_sats, 18_200);
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'needs_reconcile'").get().n, 0, 'no halt — autopilot keeps running');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'auto_extend:700:extended_reconciled'").get());
});

test('runAutoExtend LIVE: an ambiguous PUT that did NOT extend is a no-op once detail confirms no extra charge', async () => {
  const { MrrAmbiguousError } = require('../mrr-client');
  config.set(db.get(), 'run', { mode: 'live' });
  const client = {
    async put(p, params) {
      if (params && params.getcost) return sim();
      throw new MrrAmbiguousError('extend timed out');
    },
    async get(p) { return { price: { paid: 0.000618 } }; },   // 61,800 sats = exactly what we recorded -> no extension
  };
  const r = await extend.runAutoExtend(db.get(), client, okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'ambiguous_noop');
  const row = db.get().prepare('SELECT end_ts, length_hours, paid_sats FROM rentals WHERE mrr_id = 700').get();
  assert.equal(row.end_ts, NOW_SEC + 600, 'not advanced');
  assert.equal(row.length_hours, 3);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM spend_events').get().n, 0, 'no spend recorded');
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'needs_reconcile'").get().n, 0, 'no halt');
  assert.ok(db.get().prepare("SELECT 1 FROM decisions WHERE note = 'auto_extend:700:ambiguous_noop'").get());
});

test('runAutoExtend LIVE: an extend priced exactly at the rate ceiling is admitted (rated on base, not fee-inclusive)', async () => {
  config.set(db.get(), 'run', { mode: 'live' });
  // Extension base = round(61,800 / 1.03) = 60,000 sats over 3h @ 100 TH -> 200 sats/TH/hr exactly.
  // Setting the ceiling there must ADMIT (a fee-inclusive rate would compute ~206 and wrongly block).
  config.set(db.get(), 'guardrails', { rate_ceiling_sats_th_hour: 200 });
  const r = await extend.runAutoExtend(db.get(), mockClient(sim()), okSnap, { now: NOW_MS });
  assert.equal(r.decided, 'extended', 'an extend at the true ceiling is not over-rated and blocked');
  assert.equal(db.get().prepare("SELECT COUNT(*) n FROM spend_events WHERE kind = 'extend'").get().n, 1);
});

test('planExtend: refuses a cost that is implausibly small vs the original rate (units mismatch guard)', () => {
  // rental original hourly = 61,800/3 = 20,600 sats/hr. A BTC-denominated cost (~1e8 too small)
  // would read as far below the original rate and must be refused, not authorized.
  const btcScaleCost = 61_800 / 1e8;   // what the marketplace value would look like if it were BTC
  const p = extend.planExtend({ rental, sim: sim({ cost: btcScaleCost }), tolerancePct: 10, budgetRemainingSats: 1e9, windowRemainingH: 100 });
  assert.equal(p.reason, 'cost_unit_suspect');
});
