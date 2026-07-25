'use strict';
/*
 * Autopilot decide() — the top-up brain (pure). Given a snapshot of an autopilot session
 * and the current market, it decides whether to rent more hashrate to hold the target and
 * exactly which rigs. No I/O, no Date.now() — every input is passed in, so this is fully
 * unit-testable against fixtures. decide() only PROPOSES actions; the gate authorizes them
 * and execute performs the mutations.
 *
 * Algorithm (friend's call-flow spec, adapted to MRR + Pickhash):
 *  - Only an ACTIVE autopilot session tops up; quick sessions wind down as rentals expire.
 *  - Never top up on a stale observation: if the rentals fetch failed this tick we can't see
 *    what we already hold, so proposing a rent risks a duplicate (the autopilot-learned
 *    duplicate-order guard) — return nothing.
 *  - active_th = sum of each active rental's CONTRIBUTION: its advertised hashrate while
 *    pending/ramping/healthy (we've paid for it and expect delivery), but its measured
 *    delivered_th once a rig is CONFIRMED degraded/offline (past the health debounce). So a
 *    real underdelivery gap triggers a top-up, while a rig merely ramping does not make us
 *    over-rent.
 *  - Trigger only when active_th < target × (1 − tolerance).
 *  - needed_th = target − active_th. Feasibility-filter candidates: min rental length must
 *    fit the remaining window, min commit cost must fit the remaining budget, and we never
 *    re-rent a rig we already hold.
 *  - Greedily add cheapest-rank rigs until Σ advertised ≥ needed_th or the budget/rig list is
 *    exhausted; a rig whose min-commit cost would cross the remaining budget is skipped, not
 *    fatal. If still short of target, propose the partial set and report a shortfall — never
 *    block on an unattainable target.
 *  - At/after the time cap: propose nothing (stop opening; never cancel paid-for time).
 */
const quote = require('../quote');

const FEE_RATE = quote.FEE_RATE;

/** Fee-inclusive cost to rent a rig for `hours` (reproduces MRR's per-rental rounding). */
function rentCostSats(hourBtc, hours) {
  const base = Math.round((hourBtc || 0) * hours * 1e8);
  const fee = Math.round(base * FEE_RATE);
  return { base, fee, total: base + fee };
}

/**
 * Pack `feasible` rigs (rank-sorted cheapest-per-delivered-TH first) to cover `neededTh` as cheaply as
 * possible, BOUNDING overshoot so a small target is never filled by a hugely-oversized rig.
 *
 * Coverage is in EXPECTED DELIVERED TH (advertised x learned delivery), so the target is held in real
 * hashrate, not headline numbers. Each step takes whichever makes the cheapest progress toward the gap:
 *   - a sub-gap rig (all of its delivered TH is useful) — compared by cost per delivered TH, or
 *   - the closing rig (only `gap` of it is useful; the rest is paid overshoot) — a clean fit
 *     (<= fitTol) preferred over a wasteful one, chosen by cheapest ABSOLUTE rate (delivery already
 *     lives in coverage), and only overshoot within maxOvershoot allowed (else a bounded shortfall,
 *     retried next tick).
 *
 * Budget-aware via costOf + budgetRemaining. Pure — the single source of truth for the live decide
 * loop and the pre-session estimate, so the Autopilot preview can't diverge from execution.
 * Returns { selection: [rig], coveredTh (expected delivered), cost }.
 */
function packToTarget(feasible, neededTh, { fitTol, maxOvershoot, budgetRemaining, costOf }) {
  const selection = [];
  let selTh = 0;   // expected DELIVERED TH covered so far
  let selCost = 0;
  const used = new Set();
  const del = (r) => (r.expectedDelivery > 0 ? r.expectedDelivery : 1);
  const effTh = (r) => (r.advertisedTh || 0) * del(r);          // expected delivered TH (coverage weight)
  const rate = (r) => (r.hourBtc || 0);                         // absolute hold cost/hr; delivery is in effTh
  const cheapestRate = (rigs) => rigs.reduce((a, b) => (rate(b) < rate(a) ? b : a));
  const take = (r) => { selection.push(r); selTh += effTh(r); selCost += costOf(r); used.add(String(r.id)); };

  while (selTh < neededTh - 1e-9) {
    const gap = neededTh - selTh;
    const avail = feasible.filter((r) => !used.has(String(r.id)) && selCost + costOf(r) <= budgetRemaining);
    if (!avail.length) break;                                     // out of affordable rigs -> partial fill + shortfall
    // The cheapest CLEAN-FIT closer (covers the gap with <= fitTol overshoot), by absolute rate.
    const clean = avail.filter((r) => effTh(r) >= gap && effTh(r) <= gap * (1 + fitTol));
    const bestClean = clean.length ? cheapestRate(clean) : null;
    // The cheapest sub-gap rig by cost-per-delivered-TH (feasible is rank-sorted, so the first wins).
    const cheapSmall = avail.find((r) => effTh(r) < gap);
    if (bestClean && cheapSmall) {
      // Take whichever makes cheaper progress toward the gap: accumulate the sub-gap rig (all of its
      // delivered TH is useful) vs close now (only `gap` of the closer is useful; the rest is paid
      // overshoot). Cost per useful delivered TH: rate/effTh for the small rig, rate/gap for the closer.
      const accumulateIsCheaper = rate(cheapSmall) / (effTh(cheapSmall) || 1) < rate(bestClean) / gap;
      if (accumulateIsCheaper) { take(cheapSmall); continue; }
      take(bestClean); break;
    }
    if (bestClean) { take(bestClean); break; }
    if (cheapSmall) { take(cheapSmall); continue; }
    // Only oversized rigs remain: close with the cheapest to hold within the overshoot ceiling.
    const over = avail.filter((r) => effTh(r) - gap <= gap * maxOvershoot);
    if (over.length) { take(cheapestRate(over)); break; }
    break;                                                        // nothing covers the gap within the ceiling -> shortfall
  }
  return { selection, coveredTh: selTh, cost: selCost };
}

/**
 * Protective +1% rate cap for a rig, expressed per PH/day (what MRR's create expects).
 * Mirrors session.rateCapPhDay: priceBtcThDay is per TH/day, ×1000 to PH/day, +1% headroom.
 */
function rateCapPhDay(rig) {
  return Number(((rig.priceBtcThDay || 0) * 1000 * 1.01).toFixed(8));
}

/**
 * A rental's effective hashrate toward the target (see the active_th note above).
 * `opts.now` (unix s) + `opts.replaceLeadSec` enable the replace-lookahead: a rig within the lead
 * window of its end is about to cliff to zero (MRR rentals stop HARD at end_ts, they don't ramp
 * down), so it's counted as already gone — the gap opens early and a replacement is rented WHILE
 * it still delivers, overlapping the new rig's ~2.5min ramp dead-time instead of a hard handoff gap.
 */
function contributionTh(r, opts = {}) {
  const confirmedBad = r.health === 'degraded' || r.health === 'offline';
  if (confirmedBad) return r.delivered_th || 0;
  const leadSec = opts.replaceLeadSec || 0;
  if (leadSec > 0 && opts.now != null && r.end_ts != null && r.end_ts - opts.now <= leadSec) return 0;
  return r.advertised_th || 0;
}

/**
 * @param {object} ctx
 *   session: { mode, state, target_th, budget_sats, time_cap_hours, spent_sats, started_at }
 *   rentals: our active-session rental rows (advertised_th, delivered_th, health, rig_id, ended)
 *   marketRigs: normalized market rigs (market.normalizeRig shape) for candidate selection
 *   now: unix seconds; fetchOk: did the rentals/market fetch succeed this tick (dup-rent guard)
 *   hashrateTolerancePct, minRpi, stabilityTolerancePct, blacklist, endpointDiff, strictDiff, rigScores
 * @returns { actions, activeTh, targetTh, neededTh, shortfallTh, windowRemainingH, budgetRemainingSats, notes }
 */
function decide(ctx = {}) {
  const notes = [];
  const session = ctx.session;
  const base = () => ({
    actions: [], activeTh, targetTh, neededTh: 0, shortfallTh: 0,
    windowRemainingH, budgetRemainingSats: budgetRemaining, notes,
  });

  let activeTh = 0;
  let targetTh = session ? (session.target_th || 0) : 0;
  let windowRemainingH = Infinity;
  let budgetRemaining = Infinity;

  if (!session || session.mode !== 'autopilot' || session.state !== 'active') {
    notes.push('not_autopilot');
    return base();
  }
  // Duplicate-order guard: a failed rentals fetch must never read as "we own nothing".
  if (ctx.fetchOk === false) { notes.push('fetch_not_ok'); return base(); }

  const nowSec = ctx.now;
  const startedAt = session.started_at || nowSec;
  const timeCapH = session.time_cap_hours || 0;
  const elapsedH = Math.max(0, (nowSec - startedAt) / 3600);
  windowRemainingH = timeCapH > 0 ? timeCapH - elapsedH : Infinity;

  const active = (ctx.rentals || []).filter((r) => !r.ended);
  activeTh = active.reduce((s, r) => s + contributionTh(r, { now: nowSec, replaceLeadSec: ctx.replaceLeadSec }), 0);

  const budgetSats = session.budget_sats != null ? session.budget_sats : Infinity;
  const spentSats = session.spent_sats || 0;
  budgetRemaining = budgetSats - spentSats;

  // Time cap reached -> stop opening new rentals (paid time keeps running; we never cancel).
  if (windowRemainingH <= 0) { notes.push('time_cap_reached'); return base(); }

  // Within the tolerance band -> nothing to do.
  const tol = (ctx.hashrateTolerancePct != null ? ctx.hashrateTolerancePct : 5) / 100;
  if (activeTh >= targetTh * (1 - tol)) { notes.push('within_tolerance'); return base(); }

  const neededTh = targetTh - activeTh;

  // Eligible + rank-sorted candidates (reuses the proven quote pipeline), minus rigs we
  // already hold and minus rigs that can't fit the remaining window or budget.
  const heldRigIds = new Set(active.map((r) => String(r.rig_id)));
  const ranked = quote.candidates(ctx.marketRigs || [], {
    mode: 'autopilot',
    minRpi: ctx.minRpi, blacklist: ctx.blacklist, stabilityTolerancePct: ctx.stabilityTolerancePct,
    endpointDiff: ctx.endpointDiff, strictDiff: ctx.strictDiff, rigScores: ctx.rigScores,
  });
  const feasible = ranked.filter((r) => {
    if (heldRigIds.has(String(r.id))) return false;
    const minH = r.minHours || r.minRentalLength || 0;
    if (!(minH > 0)) return false;                       // can't rent a zero-length rig
    if (minH > windowRemainingH) return false;           // min length won't fit the window
    if (r.minCommitSats > budgetRemaining) return false; // min commit won't fit the budget
    return true;
  });

  // Fill the gap with the shared packer (also used by the pre-session estimate): accumulate the
  // cheapest delivered-TH rigs and close with the cheapest rig that covers the gap without exceeding
  // the overshoot ceiling. neededTh is a DELIVERED gap (target - delivered so far) and the packer's
  // coverage is delivery-weighted, so coveredTh here is EXPECTED DELIVERED TH.
  const fitTol = (ctx.fitTolerancePct != null ? ctx.fitTolerancePct : 20) / 100;
  const maxOvershoot = (ctx.maxOvershootPct != null ? ctx.maxOvershootPct : 50) / 100;
  const hoursOf = (r) => Math.min(r.minHours || r.minRentalLength || 0, windowRemainingH);
  const costOf = (r) => rentCostSats(r.hourBtc, hoursOf(r)).total;
  const anyAffordable = feasible.some((r) => costOf(r) <= budgetRemaining);

  const { selection: picked, coveredTh } = packToTarget(feasible, neededTh, { fitTol, maxOvershoot, budgetRemaining, costOf });
  const selection = picked.map((r) => ({ rig: r, hours: hoursOf(r) }));

  if (!selection.length) {
    // Empty because nothing was affordable (no_affordable_candidate) vs affordable rigs all
    // overshot the small gap beyond the ceiling (no_fit) — distinct so a soak can tell them apart.
    notes.push(anyAffordable ? 'no_fit' : 'no_affordable_candidate');
    return { actions: [], activeTh, targetTh, neededTh, shortfallTh: neededTh, windowRemainingH, budgetRemainingSats: budgetRemaining, notes };
  }

  const shortfallTh = Math.max(0, neededTh - coveredTh);
  if (shortfallTh > 1e-9) notes.push('shortfall');

  const actions = selection.map((x) => {
    const { base: paidSats, fee: feeSats } = rentCostSats(x.rig.hourBtc, x.hours);
    const od = x.rig.optimalDiff || {};
    return {
      type: 'TOPUP_RENT',
      rigId: x.rig.id, rigName: x.rig.name, region: x.rig.region,
      advertisedTh: x.rig.advertisedTh, lengthHours: x.hours,
      rateCapPhDay: rateCapPhDay(x.rig), paidSats, feeSats,
      // Telemetry persistRental records (same shape as a quick-session intent).
      rateBtcThDay: x.rig.priceBtcThDay != null ? x.rig.priceBtcThDay : null,
      endpointDiff: ctx.endpointDiff != null ? ctx.endpointDiff : null,
      optimalDiffMin: od.min != null ? od.min : null,
      optimalDiffMax: od.max != null ? od.max : null,
      diffInRange: x.rig.diffInRange,
    };
  });

  return {
    actions, activeTh, targetTh, neededTh, shortfallTh,
    windowRemainingH, budgetRemainingSats: budgetRemaining, notes,
  };
}

module.exports = { decide, packToTarget, contributionTh, rentCostSats, rateCapPhDay, FEE_RATE };
