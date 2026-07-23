'use strict';
/*
 * Auto-extend (opt-in). Near a healthy rental's end, extending it in place avoids
 * the churn and re-ramp of renting a fresh rig — but MRR extends at the rig's CURRENT rate, so
 * we ALWAYS simulate first (getcost) and only extend when the new rate is within tolerance of
 * what we originally paid AND the budget/time-cap still allow. Default OFF; every extension is a
 * real spend, authorized by the same gate as a top-up. Only autopilot 'active' sessions extend
 * (a winding-down session is spending nothing more; a quick session is a fixed one-shot).
 */
const config = require('../config');
const gate = require('./gate');
const alerts = require('../alerts');
const { MrrAmbiguousError } = require('../mrr-client');

const EXTEND_WINDOW_SEC = 30 * 60;   // consider extending within 30 min of a rental's end
const EXTEND_RETRY_SEC = 10 * 60;    // re-evaluate a given rental at most this often (bounds getcost calls)
const DAY = 86400;

/** Fee-inclusive original hourly rate we paid for a rental (sats/hr). */
function originalHourly(rental) {
  const total = (rental.paid_sats || 0) + (rental.fee_sats || 0);
  return rental.length_hours > 0 ? total / rental.length_hours : Infinity;
}

/**
 * Pure: given a rental and its getcost simulation, decide whether to extend.
 * sim: { cost (fee-incl sats), new_hrs, current_hrs, maxhrs }.
 * Returns { extend:true, lengthHours, costSats } or { extend:false, reason }.
 */
function planExtend({ rental, sim, tolerancePct, budgetRemainingSats, windowRemainingH }) {
  const no = (reason) => ({ extend: false, reason });
  if (!sim) return no('no_sim');
  const cost = Number(sim.cost);
  const length = Number(sim.new_hrs) - Number(sim.current_hrs);
  if (!(cost > 0) || !(length > 0)) return no('not_extendable');
  const orig = originalHourly(rental);
  if (!Number.isFinite(orig)) return no('unknown_original_rate');   // no length_hours -> can't price-guard, don't extend blind
  // Units sanity guard: the extension's fee-inclusive hourly rate should track the rig's original
  // rate. A value FAR below it (a BTC-denominated cost where sats are expected reads ~1e8 too
  // small) would otherwise slip past every downstream check (under-budget, under-price) and
  // authorize a spend whose true cost is ~1e8x larger. Refuse rather than trust a suspect number.
  const extHourly = cost / length;
  if (extHourly < orig / 10) return no('cost_unit_suspect');
  if (sim.maxhrs != null && Number(sim.new_hrs) > Number(sim.maxhrs) + 1e-9) return no('over_maxhours');
  if (length > windowRemainingH + 1e-9) return no('over_time_cap');
  if (cost > budgetRemainingSats) return no('over_budget');
  // Price guard: the extension's fee-inclusive hourly rate must be within tolerance of the original.
  const tol = 1 + (tolerancePct != null ? tolerancePct : 10) / 100;
  if (extHourly > orig * tol) return no('price_jumped');
  return { extend: true, lengthHours: length, costSats: cost };
}

/**
 * Recently attempted? Time-boxed so a DRY-RUN rehearsal or a transient decline (e.g. a momentary
 * price spike) doesn't permanently disqualify a healthy rental — it's just re-evaluated after the
 * window — while still bounding getcost calls to at most one per rental per window.
 */
function attempted(conn, mrrId, sinceSec) {
  return !!conn.prepare('SELECT 1 FROM decisions WHERE ts >= ? AND note LIKE ?').get(sinceSec, `auto_extend:${mrrId}:%`);
}

/**
 * Compact getcost sim summary for telemetry — captures WHY an extend was / wasn't possible.
 * `cost_raw` is MRR's field VERBATIM (no unit conversion): the getcost cost unit is unverified
 * against a live extend (the ref says BTC, but planExtend currently treats it as sats), so we
 * record it as-is — the soak's first real sim lets us settle the unit rather than bake a guess in.
 */
function simSummary(sim) {
  if (!sim) return null;
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return {
    maxhrs: n(sim.maxhrs), current_hrs: n(sim.current_hrs), new_hrs: n(sim.new_hrs),
    cost_raw: sim.cost != null ? Number(sim.cost) : null,
  };
}

/**
 * Determine the truth of an AMBIGUOUS extend PUT by reading the rental's authoritative detail,
 * rather than halting blindly. The PUT may or may not have extended on MRR:
 *   - detail shows a total charged BEYOND what we've recorded -> the extension applied. Record the
 *     ACTUAL delta (keeps the budget accurate, advances end_ts so it isn't re-selected).
 *   - charge unchanged -> it didn't apply; a no-op, retry next window.
 *   - detail itself unreachable (compound failure) -> raise a reconcile halt so no further spend
 *     races an unknown state; it's auto-cleared when the session closes (ledger reconciles the money).
 * This keeps autopilot running through a lone extend timeout instead of self-disabling on it.
 * Returns the decision/marker string.
 */
async function reconcileAmbiguousExtend(conn, client, session, rental, plan, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  let detail;
  try { detail = await client.get(`/rental/${rental.mrr_id}`); }
  catch {
    alerts.raiseReconcile(conn, { key: `xamb${rental.mrr_id}`, now: nowMs, context: { mrr_id: rental.mrr_id, rig: rental.rig_id, extend: true } });
    return 'ambiguous_extend';
  }
  const realTotal = detail && detail.price && detail.price.paid != null ? Math.round(Number(detail.price.paid) * 1e8) : null;
  const recorded = (rental.paid_sats || 0) + (rental.fee_sats || 0);
  if (realTotal == null || !(realTotal > recorded)) return 'ambiguous_noop';   // no charge beyond recorded -> extend didn't take
  const deltaTotal = realTotal - recorded;                                     // the ACTUAL amount MRR charged for the extension
  const dBase = Math.round(deltaTotal / 1.03);
  const dFee = deltaTotal - dBase;
  conn.prepare('UPDATE rentals SET length_hours = length_hours + ?, end_ts = end_ts + ?, paid_sats = paid_sats + ?, fee_sats = fee_sats + ? WHERE mrr_id = ?')
    .run(plan.lengthHours, Math.round(plan.lengthHours * 3600), dBase, dFee, rental.mrr_id);
  conn.prepare('UPDATE sessions SET spent_sats = COALESCE(spent_sats, 0) + ?, fee_sats = COALESCE(fee_sats, 0) + ? WHERE id = ?')
    .run(deltaTotal, dFee, session.id);
  conn.prepare('INSERT INTO spend_events (ts, sats, kind, session_id, mrr_id) VALUES (?, ?, ?, ?, ?)')
    .run(nowSec, deltaTotal, 'extend', session.id, rental.mrr_id);
  alerts.fireOnce(conn, { kind: 'rental_extended', key: `x${rental.mrr_id}_${rental.end_ts}`, now: nowMs, context: { rig: rental.rig_id, name: rental.rig_name, hours: plan.lengthHours, sats: deltaTotal, reconciled: true } });
  return 'extended_reconciled';
}

/**
 * Impure: at most one EXTENSION per tick. Walks the near-end healthy rentals in end-order; a
 * transient getcost/extend failure on one moves on to the next (a broken rig can't starve the
 * others). LIVE extends, DRY-RUN rehearses, and a real decline (price/budget/window) is recorded.
 */
async function runAutoExtend(conn, client, snapshot, opts = {}) {
  const nowMs = opts.now || Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const strat = config.get(conn, 'strategy');
  if (!strat.auto_extend) return { ran: false, reason: 'disabled' };
  if (!client) return { ran: false, reason: 'no_client' };
  if (!(snapshot && snapshot.endpoint && snapshot.endpoint.ok)) return { ran: false, reason: 'endpoint_unhealthy' };
  if (alerts.reconcileHalted(conn)) return { ran: false, reason: 'needs_reconcile' };

  const session = conn.prepare("SELECT * FROM sessions WHERE mode = 'autopilot' AND state = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!session) return { ran: false, reason: 'no_autopilot_session' };

  // Extend owns the window (replaceLead, EXTEND_WINDOW]; the last `replaceLead` before end belongs
  // to the top-up lookahead (decide rents a REPLACEMENT there). Excluding it means a rig is never
  // both extended AND replaced in the same handoff: extend gets first crack 30min out, and if it
  // can't (not_extendable / price), the replacement takes over in the final minutes.
  const replaceLeadSec = (strat.replace_lead_minutes || 0) * 60;
  const candidates = conn.prepare(
    "SELECT * FROM rentals WHERE session_id = ? AND ended = 0 AND health = 'healthy' AND end_ts IS NOT NULL AND (end_ts - ?) > ? AND (end_ts - ?) <= ? ORDER BY end_ts",
  ).all(session.id, nowSec, replaceLeadSec, nowSec, EXTEND_WINDOW_SEC)
    .filter((r) => !attempted(conn, r.mrr_id, nowSec - EXTEND_RETRY_SEC));
  if (!candidates.length) return { ran: false, reason: 'no_candidate' };

  const dryRun = (config.getKey(conn, 'run', 'mode') || 'dry-run') !== 'live';
  // The note stays a stable machine-readable string; the getcost sim's raw numbers ride along in
  // executed_json so a soak can tell WHY an extend was/wasn't possible (e.g. a not_extendable with
  // maxhrs == current_hrs = rig at its max length, vs new_hrs < asked = we over-asked).
  const mark = (mrrId, note, extra) => conn.prepare('INSERT INTO decisions (ts, session_id, dry_run, note, executed_json) VALUES (?, ?, ?, ?, ?)')
    .run(nowSec, session.id, dryRun ? 1 : 0, `auto_extend:${mrrId}:${note}`, extra ? JSON.stringify(extra) : null);
  const windowRemainingH = session.time_cap_hours > 0
    ? session.time_cap_hours - (nowSec - (session.started_at || nowSec)) / 3600
    : Infinity;
  const guard = config.get(conn, 'guardrails');

  for (const rental of candidates) {
    const askHours = Math.min(rental.length_hours || 0, windowRemainingH);
    if (!(askHours > 0)) { mark(rental.mrr_id, 'declined:no_window'); return { ran: true, decided: 'no_window' }; }

    let sim;
    try { sim = await client.put(`/rental/${rental.mrr_id}/extend`, { length: askHours, getcost: 1 }); }
    catch { continue; }   // transient sim failure -> try the next candidate this tick
    const simInfo = simSummary(sim);   // { maxhrs, current_hrs, new_hrs, cost_raw } for telemetry

    const budgetRemaining = (session.budget_sats != null ? session.budget_sats : Infinity) - (session.spent_sats || 0);
    const plan = planExtend({ rental, sim, tolerancePct: strat.auto_extend_price_tolerance_pct, budgetRemainingSats: budgetRemaining, windowRemainingH });
    if (!plan.extend) { mark(rental.mrr_id, `declined:${plan.reason}`, simInfo); return { ran: true, decided: plan.reason, sim: simInfo }; }

    const dailySpent = conn.prepare('SELECT COALESCE(SUM(sats), 0) AS s FROM spend_events WHERE ts >= ?').get(nowSec - DAY).s;
    const lastRentAt = conn.prepare('SELECT COALESCE(MAX(ts), 0) AS t FROM spend_events').get().t;
    // Split the fee-inclusive extend cost into base + 3% fee, matching how a fresh rent's cost is
    // expressed — so the gate's optional rate ceiling rates an extend the same way it rates a
    // top-up. (A fee-inclusive paidSats would over-rate it ~3% and wrongly block an extend sitting
    // at the true ceiling.) actionCost is still base+fee = costSats, so the budget checks are unchanged.
    const extBase = Math.round(plan.costSats / 1.03);
    const feePart = plan.costSats - extBase;
    const action = { type: 'EXTEND', rigId: rental.rig_id, advertisedTh: rental.advertised_th, lengthHours: plan.lengthHours, paidSats: extBase, feeSats: feePart };
    const g = gate.gate([action], {
      runMode: config.getKey(conn, 'run', 'mode') || 'dry-run',
      endpointDown: alerts.newRentsHalted(conn),
      sessionBudgetSats: session.budget_sats, sessionSpentSats: session.spent_sats || 0,
      maxSessionBudgetSats: guard.max_session_budget_sats, maxDailySpendSats: guard.max_daily_spend_sats,
      dailySpentSats: dailySpent, rateCeilingSatsThHour: guard.rate_ceiling_sats_th_hour,
      pacingSec: strat.rent_pacing_seconds, lastRentAt, now: nowSec,
    });

    if (g.wouldDo.length) { mark(rental.mrr_id, `dry_run:${plan.lengthHours}h_${plan.costSats}sats`, simInfo); return { ran: true, decided: 'would_extend', plan, sim: simInfo }; }
    if (!g.authorized.length) {
      const reason = (g.blocked[0] && g.blocked[0].reason) || 'gated';
      if (reason === 'paced') return { ran: false, reason: 'paced' };   // no marker — retry next tick
      mark(rental.mrr_id, `declined:${reason}`, simInfo);
      return { ran: true, decided: reason, sim: simInfo };
    }

    // LIVE: perform the extension. A PUT is a mutation, so an AMBIGUOUS failure (timeout / 5xx /
    // unparseable) may actually have extended on MRR — we must NOT silently move on and let the
    // next tick re-extend (that double-charges real BTC). Reconcile by OBSERVING the authoritative
    // detail (see reconcileAmbiguousExtend); a non-ambiguous failure is a clean no-op -> next candidate.
    try { await client.put(`/rental/${rental.mrr_id}/extend`, { length: plan.lengthHours }); }
    catch (e) {
      if (e instanceof MrrAmbiguousError) {
        const outcome = await reconcileAmbiguousExtend(conn, client, session, rental, plan, nowMs);
        mark(rental.mrr_id, outcome, simInfo);
        return { ran: true, decided: outcome, sim: simInfo };
      }
      continue;
    }
    conn.prepare('UPDATE rentals SET length_hours = length_hours + ?, end_ts = end_ts + ?, paid_sats = paid_sats + ?, fee_sats = fee_sats + ? WHERE mrr_id = ?')
      .run(plan.lengthHours, Math.round(plan.lengthHours * 3600), extBase, feePart, rental.mrr_id);
    conn.prepare('UPDATE sessions SET spent_sats = COALESCE(spent_sats, 0) + ?, fee_sats = COALESCE(fee_sats, 0) + ? WHERE id = ?')
      .run(plan.costSats, feePart, session.id);
    conn.prepare('INSERT INTO spend_events (ts, sats, kind, session_id, mrr_id) VALUES (?, ?, ?, ?, ?)')
      .run(nowSec, plan.costSats, 'extend', session.id, rental.mrr_id);
    mark(rental.mrr_id, `extended:${plan.lengthHours}h_${plan.costSats}sats`, simInfo);
    alerts.fireOnce(conn, { kind: 'rental_extended', key: `x${rental.mrr_id}_${rental.end_ts}`, now: nowMs, context: { rig: rental.rig_id, name: rental.rig_name, hours: plan.lengthHours, sats: plan.costSats } });
    return { ran: true, decided: 'extended', plan, sim: simInfo };
  }
  return { ran: false, reason: 'no_extendable_candidate' };   // every candidate's sim failed transiently
}

module.exports = { planExtend, runAutoExtend, originalHourly, EXTEND_WINDOW_SEC };
