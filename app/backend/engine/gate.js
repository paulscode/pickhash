'use strict';
/*
 * Autopilot gate() — authorizes decide()'s proposed actions (pure). The SAFETY checks are
 * mode-independent — the per-session budget, the two global spend ceilings, the endpoint-down
 * halt, and an optional rate ceiling all apply whether we're LIVE or rehearsing. The run mode
 * then decides what happens to the CLEARED actions:
 *   - PAUSED  -> nothing moves; everything is blocked.
 *   - DRY-RUN -> record "would rent" for each cleared action; mutate nothing.
 *   - LIVE    -> execute, but at most ONE rent per tick and only once the pacing interval has
 *                elapsed since the last rent (MRR's limits are unpublished — be polite, and a
 *                slow drip is safer than a burst that races itself into a double-rent).
 *
 * The cumulative budget checks walk decide()'s cheapest-first order and STOP admitting once a
 * ceiling would be crossed, so a partial top-up never overspends. The two global ceilings are
 * enforced INDEPENDENTLY of the session budget, so a bug or a tampered session budget still
 * cannot breach them (defense in depth).
 */

function actionCost(a) { return (a.paidSats || 0) + (a.feeSats || 0); }

/** sats/TH/hr implied by a TOPUP_RENT action, for the optional rate ceiling (money is sats everywhere). */
function ratePerThHour(a) {
  const hrs = a.lengthHours || 0;
  const th = a.advertisedTh || 0;
  if (!(hrs > 0) || !(th > 0)) return Infinity;
  return (a.paidSats || 0) / hrs / th;
}

/**
 * @param {Array} actions   decide()'s proposed actions (cheapest-rank first)
 * @param {object} ctx
 *   runMode: 'live' | 'dry-run' | 'paused'
 *   endpointDown: boolean (alerts.newRentsHalted) — halts all rents
 *   sessionBudgetSats, sessionSpentSats: the session's own budget re-check at execution time
 *   maxSessionBudgetSats, maxDailySpendSats: global ceilings (independent of the session)
 *   dailySpentSats: rolling spend in the trailing 24h
 *   rateCeilingSatsThHour: optional hard price ceiling in sats/TH/hr (null/undefined = off)
 *   pacingSec, lastRentAt (unix s), now (unix s): rent pacing
 * @returns { mode, authorized, wouldDo, blocked: [{action, reason}] }
 */
function gate(actions = [], ctx = {}) {
  const mode = ctx.runMode || 'dry-run';
  const blocked = [];
  const block = (action, reason) => blocked.push({ action, reason });

  if (mode === 'paused') {
    for (const a of actions) block(a, 'paused');
    return { mode, authorized: [], wouldDo: [], blocked };
  }
  // Endpoint down halts every rent in every mode (a rehearsal would also not rent).
  if (ctx.endpointDown) {
    for (const a of actions) block(a, 'endpoint_down');
    return { mode, authorized: [], wouldDo: [], blocked };
  }

  const sessionBudget = ctx.sessionBudgetSats != null ? ctx.sessionBudgetSats : Infinity;
  const sessionSpent = ctx.sessionSpentSats || 0;
  const maxSession = ctx.maxSessionBudgetSats != null ? ctx.maxSessionBudgetSats : Infinity;
  const maxDaily = ctx.maxDailySpendSats != null ? ctx.maxDailySpendSats : Infinity;
  const dailySpent = ctx.dailySpentSats || 0;
  const rateCeil = ctx.rateCeilingSatsThHour != null ? ctx.rateCeilingSatsThHour : Infinity;

  const seenRig = new Set();
  const cleared = [];
  let cum = 0;
  for (const a of actions) {
    const rigId = String(a.rigId);
    if (seenRig.has(rigId)) { block(a, 'dup_rig_tick'); continue; }
    if (ratePerThHour(a) > rateCeil) { block(a, 'rate_ceiling'); continue; }
    const cost = actionCost(a);
    if (sessionSpent + cum + cost > sessionBudget) { block(a, 'session_budget'); continue; }
    if (sessionSpent + cum + cost > maxSession) { block(a, 'max_session_budget'); continue; }
    if (dailySpent + cum + cost > maxDaily) { block(a, 'max_daily_spend'); continue; }
    seenRig.add(rigId);
    cleared.push(a);
    cum += cost;
  }

  if (mode === 'dry-run') return { mode, authorized: [], wouldDo: cleared, blocked };

  // LIVE: rent pacing — at most one rent per tick, and only once the interval has elapsed.
  const pacingSec = ctx.pacingSec != null ? ctx.pacingSec : 60;
  const lastRentAt = ctx.lastRentAt || 0;
  const now = ctx.now || 0;
  if (lastRentAt && now - lastRentAt < pacingSec) {
    for (const a of cleared) block(a, 'paced');
    return { mode, authorized: [], wouldDo: [], blocked };
  }
  const authorized = cleared.slice(0, 1);
  for (const a of cleared.slice(1)) block(a, 'paced');
  return { mode, authorized, wouldDo: [], blocked };
}

module.exports = { gate, actionCost, ratePerThHour };
