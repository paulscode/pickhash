'use strict';
/*
 * Autopilot cycle — the decide -> gate -> execute step for an ACTIVE autopilot session,
 * run once per tick. It first does a cheap, market-free pre-check: if the session is at
 * target, past its time cap, or the observation was stale, it does nothing (and skips the
 * expensive market fetch entirely). Only when there is a real gap to fill does it fetch the
 * candidate rigs and propose rents. Every spend is gated by the run mode (DRY-RUN by
 * default), the per-session/global/rolling-daily budget ceilings, and rent pacing.
 */
const decide = require('./decide');
const gate = require('./gate');
const { execute } = require('./execute');
const market = require('../market');
const config = require('../config');
const alerts = require('../alerts');
const scoring = require('./scoring');

const DAY = 86400;

function decideCtx(conn, session, snapshot, nowSec, endpoint, rigScores, marketRigs) {
  const strat = config.get(conn, 'strategy');
  const guard = config.get(conn, 'guardrails');
  return {
    session,
    rentals: snapshot.rentals || [],
    now: nowSec,
    fetchOk: !!(snapshot.fetch_ok && snapshot.fetch_ok.rentals),
    blendedCeilingSatsPhDay: guard.blended_ceiling_sats_ph_day,
    hashrateTolerancePct: strat.hashrate_tolerance_pct,
    minRpi: strat.min_rpi,
    stabilityTolerancePct: strat.stability_tolerance_pct,
    blacklist: strat.blacklist_rig_ids,
    endpointDiff: endpoint.stratum_diff != null ? endpoint.stratum_diff : null,
    fitTolerancePct: strat.fit_tolerance_pct,
    maxOvershootPct: strat.max_overshoot_pct,
    replaceLeadSec: (strat.replace_lead_minutes || 0) * 60,
    rigScores: rigScores || {},
    marketRigs: marketRigs || [],
  };
}

/**
 * Run one autopilot cycle. Impure (fetches market, may create rentals). Returns a small
 * summary of what happened for the loop to fold into logs/metrics.
 */
async function runCycle(conn, client, snapshot, opts = {}) {
  const nowMs = opts.now || Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  if (!client) return { ran: false, reason: 'no_client' };
  // Re-read the session FRESH from the DB (not the tick-start snapshot): runLifecycle may have
  // just closed it this same tick, and topping up a closed session would orphan the new rental.
  const session = conn.prepare("SELECT * FROM sessions WHERE mode = 'autopilot' AND state = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!session) return { ran: false, reason: 'not_autopilot' };
  // Never open new spend while an untracked rental (an ambiguous-create orphan) is outstanding —
  // decide() can't see it, so it would rent to fill a gap that's already covered (double-spend).
  if (alerts.reconcileHalted(conn)) return { ran: false, reason: 'needs_reconcile' };

  const endpoint = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!endpoint || !endpoint.mrr_profile_id) return { ran: false, reason: 'no_endpoint' };

  // Learned per-rig delivery scores feed the rank key (a proven-reliable rig outranks a slightly
  // cheaper flaky one). Loaded from rig_scores unless the caller injected them (tests).
  const rigScores = opts.rigScores || scoring.loadRigScores(conn);

  // Cheap pre-check without touching the market: at target / capped / stale -> do nothing.
  const pre = decide.decide(decideCtx(conn, session, snapshot, nowSec, endpoint, rigScores, []));
  if (!(pre.neededTh > 0)) return { ran: false, reason: pre.notes[pre.notes.length - 1] || 'no_gap' };

  // There IS a gap — fetch candidates and decide for real.
  let marketRigs;
  try { marketRigs = await market.fetchAllRigs(client); }
  catch { return { ran: false, reason: 'market_fetch_failed' }; }

  const plan = decide.decide(decideCtx(conn, session, snapshot, nowSec, endpoint, rigScores, marketRigs));
  if (!plan.actions.length) return { ran: true, plan, outcome: { executed: [], rehearsed: [] } };

  const strat = config.get(conn, 'strategy');
  const guard = config.get(conn, 'guardrails');
  const dailySpent = conn.prepare('SELECT COALESCE(SUM(sats), 0) AS s FROM spend_events WHERE ts >= ?').get(nowSec - DAY).s;
  const lastRentAt = conn.prepare('SELECT COALESCE(MAX(ts), 0) AS t FROM spend_events').get().t;

  const gateResult = gate.gate(plan.actions, {
    runMode: config.getKey(conn, 'run', 'mode') || 'dry-run',
    endpointDown: alerts.newRentsHalted(conn),
    sessionBudgetSats: session.budget_sats,
    sessionSpentSats: session.spent_sats || 0,
    maxSessionBudgetSats: guard.max_session_budget_sats,
    maxDailySpendSats: guard.max_daily_spend_sats,
    dailySpentSats: dailySpent,
    rateCeilingSatsThHour: guard.rate_ceiling_sats_th_hour,
    pacingSec: strat.rent_pacing_seconds,
    lastRentAt,
    now: nowSec,
  });

  const outcome = await execute(conn, client, { sessionId: session.id, endpoint, gateResult });
  return { ran: true, plan, gateResult, outcome };
}

module.exports = { runCycle };
