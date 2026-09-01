'use strict';
/*
 * Quote engine (pure). Two halves:
 *   1. eligibility + derived metrics — filter the market to rentable rigs and compute
 *      the ranking inputs (this file's first half).
 *   2. packing with duration coupling — pack the cheapest reliable rigs to a quote
 *      (added in the packer half).
 *
 * Everything here is pure (data in -> data out, no I/O, no Date.now()) so it is fully
 * unit-testable against recorded market fixtures. All hashrate is TH/s; money is sats.
 */
const FEE_RATE = 0.03;   // MRR charges 3% on top (confirmed live); every total is fee-inclusive.

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

/** Derived metrics for one normalized rig (the ranking inputs). Pure. */
function derive(rig, opts = {}) {
  const rigScores = opts.rigScores || {};
  const advertisedTh = rig.advertisedTh || 0;
  const hourBtc = rig.hourBtc || 0;
  const costPerThHour = advertisedTh > 0 ? hourBtc / advertisedTh : Infinity;

  const windows = [rig.measuredTh && rig.measuredTh.m5, rig.measuredTh && rig.measuredTh.m15, rig.measuredTh && rig.measuredTh.m30]
    .filter((x) => x != null && x >= 0);
  const measuredAvgTh = windows.length ? mean(windows) : null;
  /*
   * Stability is the worst short-window deviation from advertised, as a percentage.
   *
   * It is null when there is nothing to measure, and an idle rig counts as nothing.
   * The marketplace reports 0.00 across all three windows for a rig that is not
   * currently hashing, and an unrented rig is not hashing by definition, so the
   * formula read that as deviating from advertised by 100% and called it unstable.
   *
   * Zero throughput on an unrented rig is the absence of evidence, not evidence of
   * variability, and the distinction decides whether a rig can ever be rented: called
   * unstable it is rejected forever, because it cannot hash until someone rents it and
   * nobody will. Called unmeasured it falls under the "allow rigs with no delivery
   * history" setting, where the operator decides.
   *
   * A rig that IS rented and delivering zero is a different thing and stays visible as
   * such: it is excluded as `rented` long before this, and the live loop has its own
   * dead-rig handling.
   */
  const observed = windows.some((w) => w > 0);
  const stabilityPct = (advertisedTh > 0 && windows.length && observed)
    ? (Math.max(...windows.map((w) => Math.abs(w - advertisedTh))) / advertisedTh) * 100
    : null;

  const minHours = rig.minHours || rig.minRentalLength || 0;
  const minCommitSats = Math.round(hourBtc * minHours * 1e8 * (1 + FEE_RATE));   // fee-incl minimum unavoidable spend
  const expectedDelivery = rigScores[rig.id] != null ? Number(rigScores[rig.id]) : 1.0;
  const rankKey = expectedDelivery > 0 ? costPerThHour / expectedDelivery : Infinity;

  // Whether our endpoint difficulty sits inside the rig's *optimal* range. This is a soft
  // preference, NOT a hard requirement — rentals deliver full hashrate outside it (proven
  // live: two rentals delivered 98%/101% while outside their optimal_diff). null = unknown.
  const diff = opts.endpointDiff;
  const diffInRange = (diff != null && rig.optimalDiff && rig.optimalDiff.min != null && rig.optimalDiff.max != null)
    ? (diff >= rig.optimalDiff.min && diff <= rig.optimalDiff.max)
    : null;

  return { ...rig, costPerThHour, measuredAvgTh, stabilityPct, minCommitSats, expectedDelivery, rankKey, diffInRange };
}

/**
 * Hard eligibility for a (derived) rig. Returns { ok, reasons }. Mirrors the market's
 * own filters plus ours (rpi floor, blacklist, endpoint difficulty match, stability).
 * In 'quick' mode an unstable/no-history rig is allowed (islive already screens it);
 * in 'autopilot' mode it is rejected.
 */
function eligibility(rig, opts = {}) {
  const reasons = [];
  const minRpi = opts.minRpi != null ? opts.minRpi : 90;
  const blacklist = new Set((opts.blacklist || []).map(String));
  const mode = opts.mode || 'quick';
  const tol = opts.stabilityTolerancePct != null ? opts.stabilityTolerancePct : 20;
  const allowUnproven = opts.allowUnproven === true;
  const diff = opts.endpointDiff;   // may be null/undefined when the pool difficulty is unknown

  if (rig.status && rig.status !== 'available') reasons.push('not_available');
  if (rig.rented) reasons.push('rented');
  if (!rig.online) reasons.push('offline');
  if (rig.poolstatus && rig.poolstatus !== 'online') reasons.push('pool_offline');
  if (!rig.priceEnabled) reasons.push('btc_disabled');
  if (!rig.available) reasons.push('unavailable_status');
  if (!(rig.advertisedTh > 0)) reasons.push('no_hashrate');
  if (!(rig.hourBtc > 0)) reasons.push('no_price');
  if (rig.rpi != null && rig.rpi < minRpi) reasons.push('low_rpi');
  if (blacklist.has(String(rig.id))) reasons.push('blacklisted');

  // optimal_diff is ADVISORY, not a hard filter — treating it as hard excluded ~96% of a
  // healthy 53 EH market while live rentals delivered fine outside their optimal range.
  // Only exclude when the operator opts into strict mode (e.g. a very high-diff pool that
  // genuinely under-delivers); otherwise it's a soft `diffInRange` flag surfaced as a note.
  if (opts.strictDiff && diff != null && rig.optimalDiff && rig.optimalDiff.min != null && rig.optimalDiff.max != null) {
    if (diff < rig.optimalDiff.min || diff > rig.optimalDiff.max) reasons.push('diff_mismatch');
  }

  // Stability: strict for autopilot, lenient for quick quotes.
  if (mode === 'autopilot') {
    /*
     * A rig with no short-window history has never been measured. Autopilot rejects it
     * by default, which is right on a deep market where there is always a proven
     * alternative.
     *
     * On a young one it is a deadlock: a rig cannot earn a delivery history until
     * somebody rents it, so every rig stays unproven and autopilot buys nothing while
     * the marketplace plainly lists rigs. Hence the opt-out, which the algorithm's own
     * defaults turn on where that is the normal case.
     *
     * This relaxes only "never measured". A rig that HAS been measured and came back
     * too variable is still rejected, because that is evidence rather than an absence
     * of it, and its threshold is already tunable on its own.
     */
    if (rig.stabilityPct == null) {
      if (!allowUnproven) reasons.push('no_stability_data');
    } else if (rig.stabilityPct > tol) {
      reasons.push('unstable');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** Derive + filter a market into eligible candidates, sorted by rank key ascending. */
function candidates(rigs, opts = {}) {
  const derived = rigs.map((r) => derive(r, opts));
  const eligible = derived.filter((r) => eligibility(r, opts).ok);
  eligible.sort((a, b) => a.rankKey - b.rankKey || String(a.id).localeCompare(String(b.id)));
  return eligible;
}

// ---------------------------------------------------------------------------------
// Packer (pure). Given ranked candidates and two of {budget, target, duration}, pack
// the cheapest reliable rigs and compute the third. Every total is fee-inclusive and
// MRR's per-rental fee rounding is reproduced (base = round(hourBtc·D·1e8) per rig,
// fee = round(base·3%)). Never exceeds the budget.
// ---------------------------------------------------------------------------------

/** Build the quote result for a fixed selection + duration. */
function finalize(selected, durationHours, shortfallTh, warnings) {
  let base = 0;
  let fee = 0;
  let th = 0;
  let hourBtc = 0;
  const rigs = selected.map((r) => {
    const rbase = Math.round(r.hourBtc * durationHours * 1e8);
    const rfee = Math.round(rbase * FEE_RATE);
    base += rbase; fee += rfee; th += r.advertisedTh; hourBtc += r.hourBtc;
    return {
      id: r.id, name: r.name, owner: r.owner, region: r.region, rpi: r.rpi, advertisedTh: r.advertisedTh,
      hourBtc: r.hourBtc, rateBtcThDay: r.priceBtcThDay, lengthHours: durationHours,
      paidSats: rbase, feeSats: rfee, minHours: r.minHours, maxHours: r.maxHours,
      diffInRange: r.diffInRange,
      optimalDiffMin: r.optimalDiff && r.optimalDiff.min != null ? r.optimalDiff.min : null,
      optimalDiffMax: r.optimalDiff && r.optimalDiff.max != null ? r.optimalDiff.max : null,
    };
  });
  return {
    rigs,
    durationHours,
    targetTh: th,
    totalSats: base + fee,
    baseSats: base,
    feeSats: fee,
    blendedBtcThDay: th > 0 ? (hourBtc * 24) / th : 0,
    shortfallTh: shortfallTh || 0,
    warnings: warnings || [],
  };
}

function feasibleForDuration(cands, D) {
  return cands.filter((r) => (r.minHours || 0) <= D && (r.maxHours || Infinity) >= D);
}

/** Budget + target -> duration (the duration-coupling loop). */
function packDuration(cands, budgetSats, targetTh, opts = {}) {
  const B = budgetSats / (1 + FEE_RATE);            // spendable base (sats)
  const excluded = new Set();
  const maxIter = cands.length + 5;

  for (let iter = 0; iter < maxIter; iter++) {
    const avail = cands.filter((r) => !excluded.has(r.id));
    const selected = [];
    let sumTh = 0;
    for (const r of avail) { selected.push(r); sumTh += r.advertisedTh; if (sumTh >= targetTh) break; }
    if (!selected.length) return finalize([], 0, targetTh, ['no_rigs']);

    const shortfallTh = Math.max(0, targetTh - sumTh);
    const burnPerHr = selected.reduce((s, r) => s + r.hourBtc * 1e8, 0);   // sats/hr
    const affordableD = burnPerHr > 0 ? B / burnPerHr : 0;
    let D = affordableD;

    // Drop rigs that can't run as short as the affordable duration, then re-pack.
    const tooLong = selected.filter((r) => (r.minHours || 0) > D);
    if (tooLong.length) { tooLong.forEach((r) => excluded.add(r.id)); continue; }

    // Clamp to the shortest max, floor at the longest min.
    const maxHoursMin = Math.min(...selected.map((r) => r.maxHours || Infinity));
    const minHoursMax = Math.max(...selected.map((r) => r.minHours || 0));
    D = Math.min(D, maxHoursMin);
    if (D < minHoursMax) {
      const worst = selected.reduce((a, b) => ((b.minHours || 0) > (a.minHours || 0) ? b : a));
      excluded.add(worst.id);
      continue;
    }

    const warnings = shortfallTh ? ['shortfall'] : [];
    // The budget could buy a longer run, but the rigs cap their rental length — so the
    // quote spends less than asked. Tell the user rather than silently under-spend.
    if (affordableD > maxHoursMin + 1e-6) warnings.push('maxhours_capped');

    // Rounding must not push the fee-inclusive total over budget: shave duration if so.
    let result = finalize(selected, D, shortfallTh, warnings);
    for (let g = 0; g < 8 && result.totalSats > budgetSats && D > 0; g++) {
      D -= (result.totalSats - budgetSats) / (burnPerHr * (1 + FEE_RATE)) + 1e-6;
      if (D < minHoursMax) { D = -1; break; }
      result = finalize(selected, D, shortfallTh, warnings);
    }
    if (D < minHoursMax) {
      const worst = selected.reduce((a, b) => ((b.minHours || 0) > (a.minHours || 0) ? b : a));
      excluded.add(worst.id);
      continue;
    }
    return result;
  }
  return finalize([], 0, targetTh, ['could_not_pack']);
}

/** Budget + duration -> target hashrate (pack cheapest within the hourly budget). */
function packTarget(cands, budgetSats, durationHours, opts = {}) {
  const D = durationHours;
  const budgetPerHr = D > 0 ? (budgetSats / (1 + FEE_RATE)) / D : 0;   // affordable base sats/hr
  const feasible = feasibleForDuration(cands, D);
  const selected = [];
  let spentPerHr = 0;
  for (const r of feasible) {
    const rHr = r.hourBtc * 1e8;
    if (spentPerHr + rHr <= budgetPerHr) { selected.push(r); spentPerHr += rHr; }
  }
  let result = finalize(selected, D, 0, []);
  while (result.totalSats > budgetSats && selected.length) { selected.pop(); result = finalize(selected, D, 0, []); }
  // A zero-hashrate result needs a reason, or the UI can't explain "0 TH" (the other two
  // lock modes already emit no_rigs/shortfall).
  if (!result.rigs.length) result.warnings = feasible.length ? ['budget_too_low'] : ['infeasible_duration'];
  // Bought every eligible rig at this duration with budget to spare -> hashrate is capped by
  // available SUPPLY, not spend (more budget can't add TH). The duration mode's maxhours cap
  // is the analog; flag it so the UI can say "you've priced in the whole market".
  else if (result.rigs.length === feasible.length) result.warnings = ['market_capped'];
  return result;
}

/** Target + duration -> budget (pack cheapest until the target is met). */
function packBudget(cands, targetTh, durationHours, opts = {}) {
  const D = durationHours;
  const feasible = feasibleForDuration(cands, D);
  const selected = [];
  let sumTh = 0;
  for (const r of feasible) { selected.push(r); sumTh += r.advertisedTh; if (sumTh >= targetTh) break; }
  const shortfallTh = Math.max(0, targetTh - sumTh);
  return finalize(selected, D, shortfallTh, shortfallTh ? ['shortfall'] : []);
}

/** Dispatch on which field to compute. */
function pack(cands, params) {
  const opts = params.opts || {};
  if (params.compute === 'duration') return packDuration(cands, params.budgetSats, params.targetTh, opts);
  if (params.compute === 'target') return packTarget(cands, params.budgetSats, params.durationHours, opts);
  if (params.compute === 'budget') return packBudget(cands, params.targetTh, params.durationHours, opts);
  throw new Error(`unknown compute mode: ${params.compute}`);
}

module.exports = { FEE_RATE, derive, eligibility, candidates, pack, packDuration, packTarget, packBudget, finalize };
