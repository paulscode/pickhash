'use strict';
/*
 * Engine runner — wires the control loop into the running server.
 * Per tick: observe (blip-safe), evaluate alerts, and run session lifecycle (close a
 * session whose rentals have all ended; prompt a dispute on an under-delivered rental).
 * Autopilot performs the top-up (decide/execute of NEW rentals).
 *
 * The MRR client is resolved per tick from stored creds, so the engine no-ops cleanly
 * before setup and picks creds up once configured.
 */
const { createLoop } = require('./loop');
const observe = require('./observe');
const accounting = require('./accounting');
const dispute = require('./dispute');
const alerts = require('../alerts');
const autopilot = require('./autopilot');
const endpointRepair = require('./endpoint-repair');
const extend = require('./extend');
const adopt = require('./adopt');
const scoring = require('./scoring');
const deadRigFallback = require('./dead-rig-fallback');
const ownerNudge = require('./owner-nudge');
const ledgerFetch = require('./ledger');
const config = require('../config');
const mrr = require('../mrr');

/** Close a session whose rentals have all ended; prompt disputes for under-delivered rigs. */
async function runLifecycle(conn, snapshot, nowMs, opts = {}) {
  const s = snapshot.session;
  if (!s) return;
  const rentals = conn.prepare('SELECT * FROM rentals WHERE session_id = ?').all(s.id);
  if (!rentals.length) return;

  for (const r of rentals) {
    // A rental that ended below 95% OR never produced a reading (offline its whole run ->
    // null avg_percent, the worst case) is dispute-eligible.
    if (r.ended && r.end_ts != null && (dispute.isDisputable(r.avg_percent) || r.avg_percent == null)) {
      alerts.fireOnce(conn, {
        kind: 'dispute_window', key: String(r.mrr_id), now: nowMs,
        context: { deadline_ts: dispute.disputeDeadlineTs(r.end_ts), percent: r.avg_percent, rig: r.rig_id, name: r.rig_name, links: dispute.links(r.mrr_id) },
      });
    }
  }

  if (rentals.every((r) => r.ended)) {
    // A QUICK session is one-shot -> close once its rentals end. An AUTOPILOT session must keep
    // HOLDING the target: it closes only at its time cap, on an explicit stop (winding_down), or
    // when the budget is spent. A momentary all-rentals-ended (e.g. no overlap on a handoff, or a
    // rig that went offline) must NOT end it — leave it active so THIS tick's top-up cycle (which
    // runs right after) re-rents. Closing here would strand the session with budget and time to
    // spare, which is exactly the premature-end failure the soak surfaced.
    const elapsedH = s.started_at ? (nowMs / 1000 - s.started_at) / 3600 : 0;
    const pastCap = (s.time_cap_hours || 0) > 0 && elapsedH >= s.time_cap_hours;
    // Budget is "gone" not only at exact 100% spend, but also when the remainder is too small to rent
    // anything — the caller passes budgetExhausted when this tick's top-up found no affordable rig.
    // Without it, a tiny unspendable remainder (e.g. 81 of 8245 sats) would strand the session as
    // "active" with zero live rentals until the time cap.
    const budgetGone = s.budget_sats != null && (s.spent_sats || 0) >= s.budget_sats;
    const done = s.mode !== 'autopilot' || s.state === 'winding_down' || pastCap || budgetGone || !!opts.budgetExhausted;
    if (done) {
      // Reconcile the final spend against MRR's own ledger (falls back to recorded on a blip).
      const ledger = await ledgerFetch.fetchSessionLedger(opts.client, s);
      const summary = accounting.buildSummary({ session: s, rentals, ledger });
      conn.prepare("UPDATE sessions SET state = 'ended', ended_at = ?, summary_json = ?, spent_sats = ?, fee_sats = ? WHERE id = ?")
        .run(Math.floor(nowMs / 1000), JSON.stringify(summary), summary.spent_sats, summary.fee_sats, s.id);
      // Clear any lingering ambiguous-extend halt for this session's rentals: the money is now
      // reconciled from MRR's ledger at close, so the halt (which exists only to stop a re-extend
      // race) is moot — and must not persist to block a FUTURE session's autopilot.
      for (const r of rentals) alerts.resolveReconcile(conn, `xamb${r.mrr_id}`, nowMs);
      // A rate-ceiling hold is moot once the session closes — resolve it so it doesn't linger.
      alerts.runTransition(conn, { kind: 'rate_ceiling_hold', key: String(s.id), bad: false, now: nowMs });
      alerts.fireOnce(conn, { kind: 'session_ended', key: String(s.id), now: nowMs, context: { summary } });
    }
  }
}

/**
 * Rehydrate per-rental health from the DB so a restart holds each rental's last known
 * state on the first tick (timers restart — acceptable; a genuinely-degraded rig re-trips
 * within one window) rather than resetting to 'pending' and spuriously resolving alerts.
 */
function rehydrateState(conn) {
  const rentals = {};
  const active = conn.prepare(
    "SELECT r.mrr_id, r.health, r.avg_percent, r.start_ts FROM rentals r JOIN sessions s ON s.id = r.session_id WHERE s.state = 'active' AND r.ended = 0",
  ).all();
  for (const r of active) {
    const startMs = (r.start_ts || 0) * 1000;
    rentals[r.mrr_id] = {
      health: { state: r.health || 'pending', belowSince: null, offlineSince: null, startTs: startMs, changedAt: startMs },
      percent: r.avg_percent,
    };
  }
  return { rentals, marketAt: 0, refundAt: 0, market: null };
}

/**
 * One control-tick's reactions to a snapshot, in order: alerts, session close (ledger-
 * reconciled), orphan ADOPTION / stray review, endpoint auto-repair (debounced on a fired
 * endpoint_down), then the autopilot top-up + auto-extend spend cycle — SKIPPED on a tick that
 * adopted (the new rows aren't in this snapshot yet, so decide() would double-rent). Extracted
 * from the loop's onTick so this orchestration is unit-testable. `opts.client` overrides the
 * resolved MRR client (for tests); `opts.prev`/`opts.now`/`opts.log` carry per-tick context.
 * Returns { ran, adoptedCount }.
 */
async function tickOnce(conn, dataDir, snapshot, opts = {}) {
  if (!snapshot) return { ran: false };
  const now = opts.now || Date.now();
  const prev = opts.prev || { balance: null };
  const log = opts.log || (() => {});
  const client = opts.client !== undefined ? opts.client : mrr.clientFromStore(conn, dataDir);

  alerts.evaluate(conn, snapshot, prev, now);
  await runLifecycle(conn, snapshot, now, { client });
  alerts.resolveEndedRentalAlerts(conn, now);   // backstop: clear orphaned rental alerts
  // Reconcile any ended rental the live score-fold missed (process died right after the ended=1
  // write), so a rig that delivered 0% can never stay unscored -> re-rentable. Cheap; usually 0 rows.
  try { scoring.backfillScores(conn, Math.floor(now / 1000)); } catch { /* scoring must never break a tick */ }

  // Reconciliation: adopt our own ambiguous-create orphans (so decide counts them, no double-rent);
  // genuinely-unknown rentals -> a manual-review alert.
  const recon = snapshot.reconciliation || { adopt: [], unattributable: [] };
  let adoptedCount = 0;
  // Any ambiguous-create orphan this tick means snapshot.rentals is known-incomplete (the orphan
  // isn't in it yet), so the top-up/extend cycle must NOT run — decide() would rent to fill a gap
  // already covered and double-spend. Keyed on the presence of candidates (not on adoptedCount):
  // an adopt that partially adopts then throws, or that can't run for lack of an active endpoint,
  // still leaves committed/uncounted capacity — waiting one tick is always safe.
  const skipSpendCycle = (recon.adopt || []).length > 0;
  const strayAlerts = [...(recon.unattributable || [])];
  if ((recon.adopt || []).length && snapshot.session) {
    try {
      const ep = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
      if (ep) {
        const res = await adopt.adoptStrays(conn, client, { sessionId: snapshot.session.id, endpoint: ep, adopt: recon.adopt, nowSec: Math.floor(now / 1000), dryRun: (config.getKey(conn, 'run', 'mode') || 'dry-run') !== 'live' });
        adoptedCount = res.adopted.length;
        strayAlerts.push(...res.failed);   // couldn't fully adopt -> alert instead of dropping
      }
    } catch (e) { log({ event: 'adopt_error', message: String(e && e.message) }); }
  }
  for (const stray of strayAlerts) {
    alerts.raiseReconcile(conn, { key: `mrr${stray.mrrId}`, now, context: { mrr_id: stray.mrrId, rig: stray.rigId } });
  }

  // Endpoint auto-repair, debounced on a CONFIRMED outage (endpoint_down fired ~150s) so a probe
  // blip or an oscillating HashGG report can't churn MRR pool writes every tick.
  try {
    const plan = endpointRepair.planRepair({ storedEndpoint: snapshot.endpoint, endpointOk: !!(snapshot.endpoint && snapshot.endpoint.ok), hashgg: snapshot.hashgg });
    if (plan && alerts.newRentsHalted(conn)) {
      await endpointRepair.repair(conn, client, { plan, runMode: config.getKey(conn, 'run', 'mode') || 'dry-run', now });
    }
  } catch (e) { log({ event: 'endpoint_repair_error', message: String(e && e.message) }); }

  try {
    if (client && !skipSpendCycle) {
      const r = await autopilot.runCycle(conn, client, snapshot, { now });
      // Log the per-tick outcome so a soak captures WHY autopilot did/didn't act (at-target,
      // paced, budget, market_fetch_failed, needs_reconcile) — reasons the DB tables don't record.
      if (r) log({ event: 'autopilot', ran: !!r.ran, reason: r.reason || null,
                   executed: ((r.outcome && r.outcome.executed) || []).length,
                   blocked: ((r.gateResult && r.gateResult.blocked) || []).map((b) => b.reason) });
      // The top-up wanted hashrate but couldn't afford even the cheapest rig (decide's
      // 'no_affordable_candidate'). If we're also holding nothing, the session can't make progress —
      // close it now instead of showing "running" with zero rigs until the time cap.
      if (r && r.plan && (r.plan.notes || []).includes('no_affordable_candidate')) {
        await runLifecycle(conn, snapshot, now, { client, budgetExhausted: true });
      }
      // Surface a SUSTAINED hold-below-target caused specifically by the blended rate ceiling (the
      // cap rejected affordable rigs — not a market/budget block). Arm on the first such tick, fire
      // after ~10 min so a brief no-fit gap doesn't alarm, resolve when it fills or the ceiling is
      // raised. Without this, a too-tight ceiling silently pins autopilot far below target (a soak
      // sat at ~8% of target for 2h with no on-screen reason).
      if (snapshot.session) {
        const plan = r && r.plan;
        const heldByCeiling = !!(plan && (plan.notes || []).includes('blend_ceiling') && (plan.shortfallTh || 0) > 0);
        alerts.runTransition(conn, {
          kind: 'rate_ceiling_hold', key: String(snapshot.session.id), bad: heldByCeiling, now,
          thresholdMs: 10 * 60 * 1000,
          context: heldByCeiling ? { active_th: Math.round(plan.activeTh), target_th: Math.round(plan.targetTh), shortfall_th: Math.round(plan.shortfallTh) } : {},
        });
      }
    }
  } catch (e) { log({ event: 'autopilot_error', message: String(e && e.message) }); }
  try {
    if (client && !skipSpendCycle) {
      const r = await extend.runAutoExtend(conn, client, snapshot, { now });
      if (r) log({ event: 'auto_extend', ran: !!r.ran, decided: r.decided || null, reason: r.reason || null, sim: r.sim || null });
    }
  } catch (e) { log({ event: 'auto_extend_error', message: String(e && e.message) }); }

  // Opt-in: reroute a rig that's dead on our pool (offline while the endpoint is healthy) to Ocean
  // and notify its owner. Runs BEFORE the nudge so a rerouted rig isn't also nudged. Not a spend.
  try {
    const r = await deadRigFallback.maybeReroute(conn, client, snapshot, { now });
    if (r && r.ran) log({ event: 'dead_rig_reroute', decided: r.decided, mrr_id: r.mrr_id, messaged: r.messaged });
  } catch (e) { log({ event: 'dead_rig_reroute_error', message: String(e && e.message) }); }

  // Opt-in courtesy nudge to a rig owner whose rig is sustaining under-delivery (not a spend).
  try {
    const r = await ownerNudge.maybeNudge(conn, client, { now });
    if (r && r.ran) log({ event: 'owner_nudge', decided: r.decided, mrr_id: r.mrr_id });
  } catch (e) { log({ event: 'owner_nudge_error', message: String(e && e.message) }); }

  return { ran: true, adoptedCount };
}

function startEngine(conn, dataDir, opts = {}) {
  let prev = { balance: null };
  // Fold-on-load: reconcile any ended-but-unscored rental at boot (e.g. one whose fold didn't commit
  // before a restart) before the first decide, so scoring is authoritative from the first tick.
  try { scoring.backfillScores(conn, Math.floor(Date.now() / 1000)); } catch { /* best-effort */ }
  const loop = createLoop({
    conn,
    client: null,
    intervalMs: opts.intervalMs || 60 * 1000,
    log: opts.log,
    initialState: rehydrateState(conn),
    observeFn: async (c, _client, ctx) => {
      const client = mrr.clientFromStore(conn, dataDir);
      if (!client) return { snapshot: null, nextState: ctx.prevState, idle: true };   // not configured -> don't persist junk
      // HashGG is probed only when HASHGG_HOST is set (platform deploys set it — StartOS
      // hashgg.startos, Umbrel the HashGG node IP). Empty = not probed, which also disables
      // endpoint auto-repair (it needs HashGG's reported public endpoint to re-point to). A
      // local run without HashGG relies on the endpoint_down alert + manual re-setup instead.
      return observe.observe(conn, client, {
        ...ctx, dataDir,
        hashggHost: process.env.HASHGG_HOST || '', hashggPort: process.env.HASHGG_PORT || 3000,
      });
    },
    onTick: async (snapshot) => {
      await tickOnce(conn, dataDir, snapshot, { now: Date.now(), prev, log: opts.log });
      if (snapshot) prev = { balance: snapshot.balance };
    },
  });
  loop.start();
  return loop;
}

module.exports = { startEngine, tickOnce, runLifecycle, rehydrateState };
