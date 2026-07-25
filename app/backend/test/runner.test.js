'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { runLifecycle, tickOnce } = require('../engine/runner');
const autopilot = require('../engine/autopilot');
const extend = require('../engine/extend');
const endpointRepair = require('../engine/endpoint-repair');
const adopt = require('../engine/adopt');
const alerts = require('../alerts');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-runner-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  c.prepare('DELETE FROM alerts').run();
  c.prepare('DELETE FROM rentals').run();
  c.prepare('DELETE FROM sessions').run();
});

function seedSession(rentalsSpec) {
  const c = db.get();
  const info = c.prepare("INSERT INTO sessions (mode, state, target_th, budget_sats, created_at, started_at) VALUES ('quick','active',200,50000,1,1)").run();
  const sid = Number(info.lastInsertRowid);
  for (const r of rentalsSpec) {
    c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, worker_name)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sid, r.mrr_id, r.rig_id || 1, r.name || 'rig', 100, 3, r.paid || 1000, r.fee || 30, r.end_ts || 1000, r.ended ? 1 : 0, r.health || 'ended', r.pct, 'w');
  }
  return sid;
}

test('rehydrateState restores each active rental health from the DB (no restart reset)', async () => {
  const { rehydrateState } = require('../engine/runner');
  const c = db.get();
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('quick','active',1,1)").run().lastInsertRowid);
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?,5,1,'r',100,3,1000,30,1000,9999,0,'degraded',85,'w')`).run(sid);
  const st = rehydrateState(c);
  assert.equal(st.rentals[5].health.state, 'degraded');
  assert.equal(st.rentals[5].percent, 85);
});

test('rehydrateState restores ALL health fields plus the pending/null-avg fallbacks', async () => {
  const { rehydrateState } = require('../engine/runner');
  const c = db.get();
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('quick','active',1,1)").run().lastInsertRowid);
  // health '' (falsy) -> 'pending' fallback; avg_percent NULL -> percent null.
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?,10,1,'r',100,3,1000,30,1500,9999,0,'',NULL,'w')`).run(sid);
  const st = rehydrateState(c);
  const h = st.rentals[10].health;
  assert.equal(h.state, 'pending', "falsy health falls back to 'pending'");
  assert.equal(h.belowSince, null);
  assert.equal(h.offlineSince, null);
  assert.equal(h.startTs, 1500 * 1000, 'startTs derives from start_ts * 1000');
  assert.equal(h.changedAt, 1500 * 1000, 'changedAt derives from start_ts * 1000');
  assert.equal(st.rentals[10].percent, null, 'null avg_percent restores as null percent');
});

test('rehydrateState excludes ended rentals and rentals under a non-active session', async () => {
  const { rehydrateState } = require('../engine/runner');
  const c = db.get();
  const active = Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('quick','active',1,1)").run().lastInsertRowid);
  const ended = Number(c.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('quick','ended',1,1)").run().lastInsertRowid);
  const ins = c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?,?,1,'r',100,3,1000,30,1000,9999,?,'healthy',96,'w')`);
  ins.run(active, 20, 0);   // active rental, active session -> restored
  ins.run(active, 21, 1);   // ended rental, active session -> excluded
  ins.run(ended, 22, 0);    // active rental, ended session -> excluded
  const st = rehydrateState(c);
  assert.ok(st.rentals[20], 'active rental under an active session is restored');
  assert.equal(st.rentals[21], undefined, 'an ended rental is excluded');
  assert.equal(st.rentals[22], undefined, 'a rental under a non-active session is excluded');
});

test('runLifecycle closes a session once all its rentals have ended and fires session_ended', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 1, ended: true, pct: 97 }, { mrr_id: 2, ended: true, pct: 96 }]);
  const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) };
  await runLifecycle(c, snapshot, 5_000_000);
  assert.equal(c.prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'ended');
  const ended = c.prepare("SELECT context_json FROM alerts WHERE kind = 'session_ended'").get();
  assert.ok(ended, 'session_ended alert fired');
  assert.ok(JSON.parse(ended.context_json).summary.spent_sats > 0);
});

test('runLifecycle keeps a session active while any rental still runs', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 1, ended: true, pct: 97 }, { mrr_id: 2, ended: false, pct: 98, health: 'healthy' }]);
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) }, 5_000_000);
  assert.equal(c.prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'active');
});

test('runLifecycle ends an autopilot session when the budget can no longer rent anything (before the time cap)', async () => {
  const c = db.get();
  const now = 5_000_000;                                  // ms
  const startedSec = Math.floor(now / 1000) - 3600;      // 1h ago; time_cap 24h -> NOT past cap
  // 81 sats left (8164 of 8245) — too little to rent anything; all rentals ended.
  const sid = Number(c.prepare(
    "INSERT INTO sessions (mode, state, target_th, budget_sats, spent_sats, time_cap_hours, created_at, started_at) VALUES ('autopilot','active',200,8245,8164,24,1,?)",
  ).run(startedSec).lastInsertRowid);
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?,1,1,'rig',100,3,4000,120,1000,1,'ended',96,'w')`).run(sid);
  const snap = () => ({ session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) });

  // Not 100% spent and not past the cap -> without the signal it stays active (the zombie).
  await runLifecycle(c, snap(), now);
  assert.equal(c.prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'active');

  // The top-up couldn't afford anything -> end now instead of stranding it until the time cap.
  await runLifecycle(c, snap(), now, { budgetExhausted: true });
  assert.equal(c.prepare('SELECT state FROM sessions WHERE id = ?').get(sid).state, 'ended');
});

test('runLifecycle prompts a dispute for a rental that delivered nothing (null avg_percent)', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 88, ended: true, pct: null, end_ts: 1_000_000 }]);
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) }, 5_000_000);
  assert.ok(c.prepare("SELECT 1 FROM alerts WHERE kind = 'dispute_window'").get(), 'offline-entire-run rental prompts a dispute');
});

test('runLifecycle raises no dispute_window for an ended rental with a null end_ts (no deadline computable)', async () => {
  const c = db.get();
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, target_th, budget_sats, created_at, started_at) VALUES ('quick','active',200,50000,1,1)").run().lastInsertRowid);
  // Ended, null end_ts, null avg_percent (the worst case) -> still no dispute, since the
  // 12h deadline can't be computed without an end timestamp.
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?, 99, 1, 'rig', 100, 3, 1000, 30, NULL, 1, 'ended', NULL, 'w')`).run(sid);
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) }, 5_000_000);
  assert.equal(c.prepare("SELECT COUNT(*) n FROM alerts WHERE kind = 'dispute_window'").get().n, 0,
    'null end_ts guard: no deadline, no dispute alert');
});

test('runLifecycle writes the exact reconciled spent_sats/fee_sats onto the closed session', async () => {
  const c = db.get();
  const sid = seedSession([
    { mrr_id: 1, ended: true, pct: 97, paid: 1000, fee: 30 },
    { mrr_id: 2, ended: true, pct: 96, paid: 2000, fee: 40 },
  ]);
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) }, 5_000_000);
  const row = c.prepare('SELECT spent_sats, fee_sats FROM sessions WHERE id = ?').get(sid);
  assert.equal(row.spent_sats, 3070, '(1000+30)+(2000+40), no ledger and no refunds');
  assert.equal(row.fee_sats, 70, '30 + 40');
});

test('runLifecycle reconciles the close summary against the account ledger when a client is given', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 9000001, ended: true, pct: 98, paid: 1000, fee: 30 }]);   // recorded 1030
  const client = {
    async get(p) {
      if (p === '/account/transactions') {
        return { transactions: [
          { id: '1', type: 'Payment', amount: -0.0000150, rental: '9000001' },     // 1500 sats
          { id: '2', type: 'Rental Fee', amount: -4.5e-7, rental: '9000001' },      // 45 sats
        ] };
      }
      throw new Error('unexpected ' + p);
    },
  };
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) }, 5_000_000, { client });
  const row = c.prepare('SELECT state, spent_sats FROM sessions WHERE id = ?').get(sid);
  assert.equal(row.state, 'ended');
  assert.equal(row.spent_sats, 1545, 'gross taken from the ledger (1500+45), not the recorded 1030');
});

test('runLifecycle prompts a dispute for an under-delivered ended rental, with the MRR deadline', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 77, ended: true, pct: 88, end_ts: 1_000_000 }]);
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) }, 5_000_000);
  const d = c.prepare("SELECT context_json FROM alerts WHERE kind = 'dispute_window'").get();
  assert.ok(d, 'dispute_window fired for the <95% rental');
  assert.equal(JSON.parse(d.context_json).deadline_ts, 1_000_000 + 12 * 3600);
  // A well-delivered rental raises no dispute.
  assert.equal(c.prepare("SELECT COUNT(*) n FROM alerts WHERE kind='dispute_window'").get().n, 1);
});

test('runLifecycle clears a lingering ambiguous-extend halt when the session closes (never blocks a future session)', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 1, ended: true, pct: 97 }]);
  alerts.raiseReconcile(c, { key: 'xamb1', now: 5_000_000, context: { mrr_id: 1, extend: true } });
  assert.equal(alerts.reconcileHalted(c), true, 'halted before close');
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid) }, 5_000_000);
  assert.equal(c.prepare('SELECT state FROM sessions WHERE id=?').get(sid).state, 'ended');
  assert.equal(alerts.reconcileHalted(c), false, 'the xamb halt resolves at close, so a future session is not blocked');
});

// ---- lifecycle: an autopilot session must not close on a momentary all-rentals-ended ----
const NOW_MS_LC = 1_000_000_000_000;
const NOW_SEC_LC = NOW_MS_LC / 1000;
function seedAutopilotSession(over = {}) {
  const c = db.get();
  const o = { state: 'active', target_th: 400, budget_sats: 50_000, spent_sats: 1_000, time_cap_hours: 24, started_at: NOW_SEC_LC - 3600, ...over };
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, target_th, budget_sats, spent_sats, fee_sats, time_cap_hours, created_at, started_at) VALUES ('autopilot',?,?,?,?,0,?,1,?)")
    .run(o.state, o.target_th, o.budget_sats, o.spent_sats, o.time_cap_hours, o.started_at).lastInsertRowid);
  c.prepare("INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, worker_name) VALUES (?,100,1,'r',100,3,1000,30,1000,1,'ended',97,'w')").run(sid);
  return sid;
}
const stateOf = (sid) => db.get().prepare('SELECT state FROM sessions WHERE id=?').get(sid).state;

test('runLifecycle KEEPS an autopilot session active when its rentals momentarily all end (budget + cap remain)', async () => {
  const c = db.get();
  const sid = seedAutopilotSession();   // 1h elapsed of 24h, 1k of 50k spent, all rentals ended
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid) }, NOW_MS_LC);
  assert.equal(stateOf(sid), 'active', 'not closed -> the same-tick top-up cycle can re-rent (no premature end)');
  assert.equal(c.prepare("SELECT COUNT(*) n FROM alerts WHERE kind='session_ended'").get().n, 0, 'no session_ended fired');
});

test('runLifecycle closes an autopilot session once past its time cap', async () => {
  const c = db.get();
  const sid = seedAutopilotSession({ started_at: NOW_SEC_LC - 25 * 3600, time_cap_hours: 24 });
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid) }, NOW_MS_LC);
  assert.equal(stateOf(sid), 'ended', 'past the cap -> closes');
});

test('runLifecycle closes an autopilot session once its budget is spent', async () => {
  const c = db.get();
  const sid = seedAutopilotSession({ budget_sats: 5_000, spent_sats: 5_000 });
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid) }, NOW_MS_LC);
  assert.equal(stateOf(sid), 'ended', 'budget exhausted -> closes');
});

test('runLifecycle closes a winding_down autopilot session when its rentals end', async () => {
  const c = db.get();
  const sid = seedAutopilotSession({ state: 'winding_down' });
  await runLifecycle(c, { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid) }, NOW_MS_LC);
  assert.equal(stateOf(sid), 'ended', 'explicit stop -> closes when rentals end');
});

// ---- tickOnce: the per-tick control-flow orchestration ----
// tickOnce calls its collaborators through the shared module objects (autopilot.runCycle,
// extend.runAutoExtend, endpointRepair.repair, adopt.adoptStrays), so swapping a property on
// the required module lets these tests observe the ORCHESTRATION contract (what runs, in what
// order, what's skipped) without standing up the full market/config machinery. Each stub is
// restored in a finally so there's no cross-test bleed (tests in a file run sequentially).
function stub(obj, name, fn) {
  const orig = obj[name];
  obj[name] = fn;
  return () => { obj[name] = orig; };
}
function spy(ret) {
  const fn = async (...args) => { fn.calls.push(args); return ret; };
  fn.calls = [];
  return fn;
}
function seedAutopilot(c) {
  return Number(c.prepare("INSERT INTO sessions (mode,state,target_th,budget_sats,created_at,started_at) VALUES ('autopilot','active',300,1000000,1,1)").run().lastInsertRowid);
}

test('tickOnce no-ops on a null snapshot (unconfigured / idle tick)', async () => {
  assert.deepEqual(await tickOnce(db.get(), DATA, null, { now: 1 }), { ran: false });
});

test('tickOnce adopts a matched orphan and SKIPS the top-up/extend cycle that same tick', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  c.prepare("INSERT INTO pool_endpoints (host,port,worker_base,mrr_profile_id,active) VALUES ('a.gg',3333,'w',7,1)").run();
  const restore = [
    stub(adopt, 'adoptStrays', spy({ adopted: [9001], failed: [] })),
    stub(autopilot, 'runCycle', spy({ ran: false })),
    stub(extend, 'runAutoExtend', spy({ ran: false })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [{ mrrId: '9001', rigId: 42 }], unattributable: [] } };
    const res = await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {} });
    assert.equal(res.adoptedCount, 1);
    assert.equal(adopt.adoptStrays.calls.length, 1, 'adoption attempted for the matched intent');
    assert.equal(autopilot.runCycle.calls.length, 0, 'no top-up on an adopt tick — the new row is not in this snapshot yet (would double-rent)');
    assert.equal(extend.runAutoExtend.calls.length, 0, 'no auto-extend on an adopt tick');
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce runs the top-up AND auto-extend cycle on a normal (non-adopt) tick', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  const restore = [
    stub(autopilot, 'runCycle', spy({ ran: true })),
    stub(extend, 'runAutoExtend', spy({ ran: false })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [], unattributable: [] } };
    const res = await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {} });
    assert.equal(res.adoptedCount, 0);
    assert.equal(autopilot.runCycle.calls.length, 1);
    assert.equal(extend.runAutoExtend.calls.length, 1);
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce with no MRR client skips the spend cycle but still runs lifecycle/alerts', async () => {
  const c = db.get();
  const sid = seedSession([{ mrr_id: 1, ended: true, pct: 97 }]);   // all rentals ended -> lifecycle closes it
  const restore = [
    stub(autopilot, 'runCycle', spy({ ran: true })),
    stub(extend, 'runAutoExtend', spy({ ran: true })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {} };
    const res = await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: null });
    assert.equal(res.ran, true);
    assert.equal(autopilot.runCycle.calls.length, 0, 'no client -> no top-up');
    assert.equal(extend.runAutoExtend.calls.length, 0, 'no client -> no auto-extend');
    assert.equal(c.prepare('SELECT state FROM sessions WHERE id=?').get(sid).state, 'ended', 'lifecycle still closed the finished session');
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce does NOT close an autopilot session on a momentary all-ended; the top-up cycle still sees it active', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);   // autopilot active, budget 1M, no time cap reached
  c.prepare("INSERT INTO rentals (session_id,mrr_id,rig_id,rig_name,advertised_th,length_hours,paid_sats,fee_sats,end_ts,ended,health,avg_percent,worker_name) VALUES (?,1,1,'r',100,3,1000,30,1000,1,'ended',97,'w')").run(sid);
  let stateSeenByCycle;
  const restore = stub(autopilot, 'runCycle', async (conn) => {
    stateSeenByCycle = conn.prepare('SELECT state FROM sessions WHERE id=?').get(sid).state;
    return { ran: false };
  });
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [], unattributable: [] } };
    await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {} });
    // Lifecycle still runs BEFORE the cycle, but must leave a running autopilot session ALIVE so it
    // can re-rent — closing it on a momentary all-ended is the premature-end bug.
    assert.equal(c.prepare('SELECT state FROM sessions WHERE id=?').get(sid).state, 'active', 'session survives to be re-rented');
    assert.equal(stateSeenByCycle, 'active', 'the top-up cycle sees the session still active (not stranded)');
  } finally { restore(); }
});

test('tickOnce defers endpoint repair until an endpoint_down alert has fired (debounce)', async () => {
  const c = db.get();
  c.prepare("INSERT INTO pool_endpoints (host,port,worker_base,mrr_profile_id,active) VALUES ('old.gg',3333,'w',7,1)").run();
  // A fresh probe (fetch_ok.endpoint:true) that reports the saved endpoint down: this ARMS
  // endpoint_down and only FIRES it once past the ~150s threshold.
  const snapshot = {
    session: null, rentals: [], fetch_ok: { endpoint: true },
    endpoint: { host: 'old.gg', port: 3333, ok: false },
    hashgg: { reachable: true, publicEndpoint: { host: 'new.gg', port: 4444 } },
    reconciliation: { adopt: [], unattributable: [] },
  };
  const T = 5_000_000;
  const restore = stub(endpointRepair, 'repair', spy({}));
  try {
    // Tick 1 only ARMS the outage — a valid repair plan exists but is held back so a probe blip or
    // an oscillating HashGG report can't churn MRR pool writes.
    await tickOnce(c, DATA, snapshot, { now: T, client: {} });
    assert.equal(endpointRepair.repair.calls.length, 0, 'plan exists but outage not yet confirmed -> no repair');
    // Tick 2 past the debounce threshold FIRES endpoint_down -> repair runs.
    await tickOnce(c, DATA, snapshot, { now: T + alerts.DEFAULTS.endpoint_down_ms + 1000, client: {} });
    assert.equal(endpointRepair.repair.calls.length, 1, 'confirmed outage (endpoint_down fired) -> repair runs');
  } finally { restore(); }
});

test('tickOnce fires needs_reconcile for a stray it cannot adopt, and SKIPS the cycle that tick', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  c.prepare("INSERT INTO pool_endpoints (host,port,worker_base,mrr_profile_id,active) VALUES ('a.gg',3333,'w',7,1)").run();
  const restore = [
    stub(adopt, 'adoptStrays', spy({ adopted: [], failed: [{ mrrId: '9099', rigId: 5 }] })),
    stub(autopilot, 'runCycle', spy({ ran: false })),
    stub(extend, 'runAutoExtend', spy({ ran: false })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [{ mrrId: '9099', rigId: 5 }], unattributable: [] } };
    const res = await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {} });
    assert.equal(res.adoptedCount, 0);
    const a = c.prepare("SELECT context_json FROM alerts WHERE kind='needs_reconcile' AND key='mrr9099'").get();
    assert.ok(a, 'an unadoptable stray -> needs_reconcile alert');
    assert.equal(JSON.parse(a.context_json).mrr_id, '9099');
    // A tick with adopt candidates skips the spend cycle even when adoption FAILS: an orphan may
    // have partially committed (or the adopt threw), so snapshot.rentals is untrustworthy — decide()
    // must not rent against it. (reconcileHalted would also stop runCycle internally.)
    assert.equal(autopilot.runCycle.calls.length, 0, 'adopt candidates present -> no top-up this tick (no double-rent)');
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce raises needs_reconcile for a genuinely-unknown (unattributable) rental without adopting', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  const restore = stub(adopt, 'adoptStrays', spy({ adopted: [], failed: [] }));
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [], unattributable: [{ mrrId: '7777', rigId: 3 }] } };
    await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {} });
    assert.equal(adopt.adoptStrays.calls.length, 0, 'unattributable strays are never auto-adopted');
    assert.ok(c.prepare("SELECT 1 FROM alerts WHERE kind='needs_reconcile' AND key='mrr7777'").get());
  } finally { restore(); }
});

test('tickOnce skips the spend cycle when adoption THROWS mid-loop (a partial commit must not read as no-adopt)', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  c.prepare("INSERT INTO pool_endpoints (host,port,worker_base,mrr_profile_id,active) VALUES ('a.gg',3333,'w',7,1)").run();
  const restore = [
    stub(adopt, 'adoptStrays', async () => { throw new Error('db busy mid-adopt'); }),   // throws AFTER a partial commit
    stub(autopilot, 'runCycle', spy({ ran: false })),
    stub(extend, 'runAutoExtend', spy({ ran: false })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [{ mrrId: '9001', rigId: 1 }, { mrrId: '9002', rigId: 2 }], unattributable: [] } };
    const res = await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {}, log: () => {} });
    assert.equal(res.adoptedCount, 0, 'the throw left adoptedCount 0');
    assert.equal(autopilot.runCycle.calls.length, 0, 'cycle still SKIPPED — adopt candidates present, so snapshot.rentals is untrustworthy (no double-rent)');
    assert.equal(extend.runAutoExtend.calls.length, 0);
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce skips the spend cycle when adopt candidates exist but there is no active endpoint to adopt them', async () => {
  const c = db.get();
  c.prepare('DELETE FROM pool_endpoints').run();   // no active endpoint (beforeEach doesn't clear this table)
  const sid = seedAutopilot(c);
  const restore = [
    stub(adopt, 'adoptStrays', spy({ adopted: [], failed: [] })),
    stub(autopilot, 'runCycle', spy({ ran: false })),
    stub(extend, 'runAutoExtend', spy({ ran: false })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [{ mrrId: '9001', rigId: 1 }], unattributable: [] } };
    await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {} });
    assert.equal(adopt.adoptStrays.calls.length, 0, 'no active endpoint -> adoptStrays not called');
    assert.equal(autopilot.runCycle.calls.length, 0, 'still skips the cycle — untracked running capacity would otherwise be double-rented');
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce logs the per-tick autopilot + auto-extend OUTCOME (soak telemetry: why it did/did not act)', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  const logs = [];
  const restore = [
    stub(autopilot, 'runCycle', spy({ ran: false, reason: 'market_fetch_failed' })),
    stub(extend, 'runAutoExtend', spy({ ran: false, reason: 'no_candidate' })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [], unattributable: [] } };
    await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {}, log: (e) => logs.push(e) });
    const ap = logs.find((l) => l.event === 'autopilot');
    assert.ok(ap, 'an autopilot outcome line is logged each tick');
    assert.equal(ap.reason, 'market_fetch_failed', 'the skip reason is captured');
    assert.equal(ap.executed, 0);
    const ax = logs.find((l) => l.event === 'auto_extend');
    assert.ok(ax, 'an auto_extend outcome line is logged');
    assert.equal(ax.reason, 'no_candidate');
  } finally { restore.forEach((r) => r()); }
});

test('tickOnce isolates a throwing top-up cycle (logs it, still runs auto-extend, returns ran:true)', async () => {
  const c = db.get();
  const sid = seedAutopilot(c);
  const logs = [];
  const restore = [
    stub(autopilot, 'runCycle', async () => { throw new Error('boom'); }),
    stub(extend, 'runAutoExtend', spy({ ran: false })),
  ];
  try {
    const snapshot = { session: c.prepare('SELECT * FROM sessions WHERE id=?').get(sid), rentals: [], fetch_ok: {}, reconciliation: { adopt: [], unattributable: [] } };
    const res = await tickOnce(c, DATA, snapshot, { now: 5_000_000, client: {}, log: (e) => logs.push(e) });
    assert.equal(res.ran, true);
    assert.ok(logs.some((l) => l.event === 'autopilot_error'), 'the top-up error is logged, not thrown');
    assert.equal(extend.runAutoExtend.calls.length, 1, 'auto-extend still runs after a top-up error');
  } finally { restore.forEach((r) => r()); }
});
