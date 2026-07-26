'use strict';
/*
 * Session execution — turns a confirmed quote into real (or rehearsed) MRR rentals.
 *
 * Safety is the whole point here, because this spends real BTC:
 *   - One session at a time. A synchronous in-memory guard plus an active-session DB
 *     check means two near-simultaneous confirms can't both execute (no double-spend).
 *   - The quote is re-priced at confirm; a >2% move returns a fresh quote for re-confirm
 *     instead of executing at a stale price.
 *   - The confirmed balance must cover the whole fee-inclusive total before any rental
 *     is created (fail fast rather than strand a half-funded session).
 *   - A pending-intent `decisions` row is written BEFORE each create, so a crash between
 *     "MRR created it" and "we stored the id" is reconcilable on the next observe.
 *   - A create that fails *ambiguously* (timeout / 5xx / network) is NEVER retried — the
 *     loop halts and leaves reconciliation to the control loop. A *clean* failure (rig
 *     taken / repriced) re-packs the shortfall from the next candidates (bounded rounds).
 *   - DRY-RUN walks the identical path with every mutation skipped; the decisions rows
 *     carry "would rent…" notes and nothing is purchased.
 *
 * The confirmed-live request shapes (rig create + per-rental pool override) mirror what
 * was validated against the real API.
 */
const quoteService = require('./quote-service');
const quote = require('./quote');
const market = require('./market');
const deposit = require('./deposit');
const config = require('./config');
const alerts = require('./alerts');
const accounting = require('./engine/accounting');
const ledgerFetch = require('./engine/ledger');
const decide = require('./engine/decide');
const { MrrAmbiguousError } = require('./mrr-client');

const REPRICE_TOLERANCE = 0.02;   // >2% move at confirm -> re-confirm instead of executing
const RATE_CAP_HEADROOM = 1.01;   // protective rate.price cap: quoted price +1%
const REPACK_ROUNDS = 2;          // clean-failure shortfall re-pack attempts

// In-memory guard: set synchronously (before any await) so two concurrent confirms
// can never both pass. Combined with the active-session DB check below.
let starting = false;

class SessionError extends Error {
  constructor(code, message) { super(message || code); this.name = 'SessionError'; this.code = code; }
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// The SUGGESTED blended ceiling is the estimated blend plus this much room. Pre-filling the cap at
// the bare estimate leaves ~0 headroom: the first rentals set a running blend right at the estimate,
// so any rig priced a hair above stalls the fill — autopilot sat at 8% of target for ~2h in a soak.
// The margin is baked into the number the user SEES (and can edit down), not added silently at enforce.
const CEILING_HEADROOM = 1.10;

/** Per-rig protective price cap (BTC per PH per day, +1% headroom), rounded like the API. */
function rateCapPhDay(rateBtcThDay) {
  return Number((rateBtcThDay * 1000 * RATE_CAP_HEADROOM).toFixed(8));
}

/** Pure: the ordered rental intents for a stored quote. */
function planIntents(stored) {
  const D = stored.result.durationHours;
  const endpointDiff = stored.endpointDiff != null ? stored.endpointDiff : null;
  return stored.result.rigs.map((r) => ({
    rigId: Number(r.id),
    rigName: r.name,
    region: r.region,
    advertisedTh: r.advertisedTh,
    lengthHours: D,
    paidSats: r.paidSats,
    feeSats: r.feeSats,
    rateBtcThDay: r.rateBtcThDay,
    rateCapPhDay: rateCapPhDay(r.rateBtcThDay),
    // Diff telemetry captured at rent time (correlated later with delivered %).
    endpointDiff,
    optimalDiffMin: r.optimalDiffMin != null ? r.optimalDiffMin : null,
    optimalDiffMax: r.optimalDiffMax != null ? r.optimalDiffMax : null,
    diffInRange: r.diffInRange,
  }));
}

function insertDecision(conn, sessionId, dryRun, fields) {
  conn.prepare(
    `INSERT INTO decisions (ts, session_id, dry_run, observed_json, proposed_json, gated_json, executed_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowSec(), sessionId, dryRun ? 1 : 0,
    fields.observed ? JSON.stringify(fields.observed) : null,
    fields.proposed ? JSON.stringify(fields.proposed) : null,
    fields.gated ? JSON.stringify(fields.gated) : null,
    fields.executed ? JSON.stringify(fields.executed) : null,
    fields.note || null,
  );
}

// Ocean fallback pool (priority 1): a safety net that only engages if the primary endpoint drops.
// Ocean runs real vardiff (so a rig starved by an endpoint difficulty mismatch actually hashes) and
// pays out to the SAME Bitcoin address, so a fallback still earns for the user — and MRR can't deny a
// refund for "no backup pool". The '.fallback' worker tag makes fallback hashrate obvious on Ocean.
const OCEAN_FALLBACK = { host: 'mine.ocean.xyz', port: 3334 };
function oceanFallbackWorker(workerBase) {
  const address = String(workerBase || '').split('.')[0];   // strip any '.worker' suffix -> the BTC address
  return address ? `${address}.fallback` : null;
}

/** Create one real rental + apply the per-rental worker pool override. Impure. */
async function rentOne(client, intent, endpoint, opts = {}) {
  const created = await client.put('/rental', {
    rig: intent.rigId,
    length: intent.lengthHours,
    profile: endpoint.mrr_profile_id,
    currency: 'BTC',
    rate: { type: 'ph', price: intent.rateCapPhDay },
  });
  const mrrId = Number(created && created.id);
  // A create that resolves without a usable id is treated as AMBIGUOUS, not success — we
  // may have been billed for a rental we can no longer address, so halt for reconciliation
  // rather than persist a NaN handle.
  if (!Number.isInteger(mrrId) || mrrId <= 0) throw new MrrAmbiguousError('create returned no usable rental id');
  const worker = `${endpoint.worker_base}-r${mrrId}`;
  let poolOverride = 'applied';
  try {
    await client.put(`/rental/${mrrId}/pool/0`, { host: endpoint.host, port: endpoint.port, user: worker, pass: 'x', priority: 0 });
  } catch {
    // The rental still runs on the profile's shared worker; we just lose per-rental
    // attribution. Note it rather than fail the whole session.
    poolOverride = 'fallback_shared_worker';
  }
  // Optional Ocean fallback at priority 1. Best-effort: a failure here just means this rental has no
  // safety net — it still runs on the primary, so never fail the rental over it.
  let fallback = 'off';
  const fbWorker = opts.fallbackOcean ? oceanFallbackWorker(endpoint.worker_base) : null;
  if (fbWorker) {
    fallback = 'ocean';
    try {
      await client.put(`/rental/${mrrId}/pool/1`, { host: OCEAN_FALLBACK.host, port: OCEAN_FALLBACK.port, user: fbWorker, pass: 'x', priority: 1 });
    } catch {
      fallback = 'ocean_failed';
    }
  }
  return { mrrId, worker, poolOverride, fallback, created };
}

function persistRental(conn, sessionId, intent, res) {
  const c = res.created || {};
  const start = c.start_unix != null && Number(c.start_unix) > 0 ? Number(c.start_unix) : nowSec();
  // Guard MRR's "not finalized" sentinel: end_unix 0/'' must NOT store end_ts=0, which the
  // time-fallback would read as already-ended and close the session under a live rental.
  const end = c.end_unix != null && Number(c.end_unix) > 0 ? Number(c.end_unix) : start + Math.round(intent.lengthHours * 3600);
  conn.prepare(
    `INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, region, advertised_th, length_hours,
                          paid_sats, fee_sats, rate_btc_th_day, start_ts, end_ts, health, worker_name,
                          endpoint_diff, optimal_diff_min, optimal_diff_max, diff_in_range)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(sessionId, res.mrrId, intent.rigId, intent.rigName, intent.region, intent.advertisedTh,
    intent.lengthHours, intent.paidSats, intent.feeSats, intent.rateBtcThDay, start, end, res.worker,
    intent.endpointDiff, intent.optimalDiffMin, intent.optimalDiffMax,
    intent.diffInRange == null ? null : (intent.diffInRange ? 1 : 0));
  conn.prepare('INSERT INTO spend_events (ts, sats, kind, session_id, mrr_id) VALUES (?, ?, ?, ?, ?)')
    .run(nowSec(), (intent.paidSats || 0) + (intent.feeSats || 0), 'rent', sessionId, res.mrrId);
}

/**
 * Re-pack a shortfall (clean-failure recovery) from the candidates still on the book,
 * excluding rigs already attempted, at the same fixed duration. Pure.
 */
function repackShortfall(stored, attemptedIds, shortfallTh) {
  const cands = (stored.candidates || []).filter((r) => !attemptedIds.has(Number(r.id)));
  const res = quote.packBudget(cands, shortfallTh, stored.result.durationHours);
  return planIntents({ result: res, endpoint: stored.endpoint });
}

/**
 * Start a session from a confirmed quote id. Returns a summary. On a stale price it
 * returns { needs_reconfirm, quote } without executing. Throws SessionError otherwise.
 */
async function startSession(conn, client, quoteId, opts = {}) {
  const dryRun = opts.dryRun !== false;   // default to the safe path unless explicitly LIVE

  if (starting) throw new SessionError('session_in_progress');
  starting = true;
  try {
    if (conn.prepare("SELECT id FROM sessions WHERE state IN ('active', 'winding_down')").get()) {
      throw new SessionError('session_active');
    }

    // Endpoint gate: if the pool endpoint has been unreachable long enough to trip the
    // endpoint_down alert, a LIVE confirm would pay for hashrate that can't reach the pool.
    // Block it (a DRY-RUN rehearsal is harmless and still allowed).
    if (!dryRun && alerts.newRentsHalted(conn)) throw new SessionError('endpoint_down');

    const confirmed = quoteService.getStoredQuote(quoteId);
    if (!confirmed) throw new SessionError('quote_expired');

    // Re-price over fresh market data; execute the *current* plan if the move is small.
    // Compare the blended per-PH·day price, which reflects market movement in every lock
    // mode (in duration-lock the total always tracks the budget, so a total-delta would
    // miss a price move that shortens the run). Force a fresh fetch — the 30s market cache
    // would otherwise compare the quote to itself and never fire the guard.
    const fresh = await quoteService.buildQuote(conn, client, confirmed.input, { forceMarket: true });
    if (!fresh.rig_count) throw new SessionError('no_rigs_available');
    const prevPrice = confirmed.blendedBtcPhDay;
    const delta = prevPrice > 0 ? Math.abs(fresh.blended_btc_ph_day - prevPrice) / prevPrice : 1;
    if (delta > REPRICE_TOLERANCE) {
      return {
        needs_reconfirm: true,
        previous_total_sats: confirmed.result.totalSats,
        previous_blended_btc_ph_day: prevPrice,
        quote: fresh,
      };
    }
    const stored = quoteService.getStoredQuote(fresh.id);

    // Balance gate: the whole fee-inclusive total must be covered before any create.
    let confirmedSats = stored.balanceSats;
    if (confirmedSats == null) {
      try { confirmedSats = deposit.balanceToSats(await client.get('/account/balance')).confirmed_sats; }
      catch { throw new SessionError('balance_unavailable'); }
    }
    if (!dryRun && stored.result.totalSats > confirmedSats) throw new SessionError('insufficient_balance');

    // Open the session.
    const info = conn.prepare(
      `INSERT INTO sessions (mode, state, target_th, budget_sats, duration_hours, created_at, started_at)
         VALUES ('quick', 'active', ?, ?, ?, ?, ?)`,
    ).run(stored.result.targetTh, stored.result.totalSats, stored.result.durationHours, nowSec(), nowSec());
    const sessionId = Number(info.lastInsertRowid);

    const summary = await executeSession(conn, client, stored, { dryRun, sessionId, confirmedSats });

    // Close out the session record. A DRY-RUN, or a LIVE session that ended up renting
    // NOTHING (all creates failed / an ambiguous first create), is ENDED immediately —
    // an empty active session would zombie-lock the app (nothing to monitor ever ends it,
    // and startSession refuses a new one while any session is active).
    const noRentals = summary.executed.length === 0;
    const finalState = (dryRun || noRentals) ? 'ended' : 'active';
    const endedAt = (dryRun || noRentals) ? nowSec() : null;
    conn.prepare('UPDATE sessions SET spent_sats = ?, fee_sats = ?, state = ?, ended_at = ?, summary_json = ? WHERE id = ?')
      .run(summary.total_sats, summary.fee_sats, finalState, endedAt, JSON.stringify(summary), sessionId);

    return { session_id: sessionId, ...summary };
  } finally {
    starting = false;
  }
}

/**
 * Walk the plan, creating (or rehearsing) each rental. Shared by DRY-RUN and LIVE — the
 * only difference is whether the mutation actually runs. Returns the session summary.
 */
async function executeSession(conn, client, stored, { dryRun, sessionId, confirmedSats }) {
  const endpoint = stored.endpoint;
  const fallbackOcean = !!config.get(conn, 'strategy').fallback_pool_enabled;   // Ocean safety-net at priority 1
  // Hard spend ceiling: the user's actual budget (budget-locked modes) or, when the spend
  // itself was the computed output, the total they confirmed. NO headroom — a pricier
  // re-packed replacement for a taken rig must never push spend past this, so the gate
  // stops the session rather than overspend. Also never exceed the confirmed balance.
  let budgetCeil = stored.params.budgetSats != null ? stored.params.budgetSats : stored.result.totalSats;
  // The session guardrail is a hard ceiling in EVERY lock mode — including spend-locked,
  // where there's no input budget, so a large hashrate×duration can't spend past it.
  const guardrailMax = config.getKey(conn, 'guardrails', 'max_session_budget_sats');
  if (guardrailMax != null) budgetCeil = Math.min(budgetCeil, guardrailMax);
  let ceiling = Math.min(confirmedSats != null ? confirmedSats : Infinity, budgetCeil);
  // Rolling 24h spend ceiling — the same cap the autopilot honors — applied here too, so a
  // series of quick rents can't spend past the daily limit. Measured once, BEFORE this session's
  // rents land in spend_events, so `spent + cost <= remainingDaily` holds without double-counting.
  const maxDaily = config.getKey(conn, 'guardrails', 'max_daily_spend_sats');
  if (maxDaily != null) {
    const dailySpent = conn.prepare('SELECT COALESCE(SUM(sats), 0) AS s FROM spend_events WHERE ts >= ?').get(nowSec() - 24 * 3600).s;
    ceiling = Math.min(ceiling, Math.max(0, maxDaily - dailySpent));
  }
  const attempted = new Set();
  const executed = [];
  const planned = [];
  let spent = 0;
  let fee = 0;
  let halted = false;
  let haltReason = null;

  let intents = planIntents(stored);
  let round = 0;

  while (intents.length) {
    const failedThisRound = [];
    let shortfallTh = 0;

    for (const intent of intents) {
      attempted.add(intent.rigId);
      const cost = intent.paidSats + intent.feeSats;
      planned.push({
        rig_id: intent.rigId, rig_name: intent.rigName, region: intent.region,
        advertised_th: intent.advertisedTh, length_hours: intent.lengthHours,
        paid_sats: intent.paidSats, fee_sats: intent.feeSats,
      });

      // Intent row FIRST — the reconciliation anchor if we crash mid-create.
      insertDecision(conn, sessionId, dryRun, {
        proposed: { rig: intent.rigId, name: intent.rigName, length: intent.lengthHours, rate_cap_ph_day: intent.rateCapPhDay, worker_base: endpoint.worker_base },
        note: 'intent',
      });

      // Gate: don't let cumulative spend cross the ceiling (defense in depth).
      if (!dryRun && spent + cost > ceiling) {
        insertDecision(conn, sessionId, dryRun, { gated: { rig: intent.rigId, spent, cost, ceiling }, note: 'gated_budget' });
        halted = true; haltReason = 'budget_ceiling';
        break;
      }

      if (dryRun) {
        insertDecision(conn, sessionId, dryRun, {
          executed: { would_rent: true, rig: intent.rigId, length: intent.lengthHours, cost_sats: cost },
          note: `DRY-RUN would rent rig #${intent.rigId} (${intent.rigName}) for ${intent.lengthHours}h at ${cost} sats`,
        });
        spent += cost; fee += intent.feeSats;
        continue;
      }

      // LIVE create — no retry on an ambiguous outcome.
      let res;
      try {
        res = await rentOne(client, intent, endpoint, { fallbackOcean });
      } catch (e) {
        if (e instanceof MrrAmbiguousError) {
          insertDecision(conn, sessionId, dryRun, { executed: { ambiguous: true, rig: intent.rigId }, note: 'ambiguous_halt: create outcome unknown — not retried, reconcile next tick' });
          // The create MAY have succeeded on MRR — surface an untracked/billed rental for
          // manual review rather than silently retrying (the double-rent trap). Full auto-
          // adoption of the orphan lands with autopilot; this at least never loses it.
          if (!dryRun) {
            alerts.raiseReconcile(conn, { key: `sess${sessionId}rig${intent.rigId}`, now: Date.now(), context: { rig: intent.rigId, name: intent.rigName } });
          }
          halted = true; haltReason = 'ambiguous';
          break;
        }
        // Clean failure (taken / repriced) — mark for shortfall re-pack.
        insertDecision(conn, sessionId, dryRun, { executed: { failed: true, rig: intent.rigId, error: e.name }, note: `rig_failed: ${e.name}` });
        failedThisRound.push(intent);
        shortfallTh += intent.advertisedTh;
        continue;
      }

      persistRental(conn, sessionId, intent, res);
      insertDecision(conn, sessionId, dryRun, {
        executed: { mrr_id: res.mrrId, rig: intent.rigId, worker: res.worker, pool_override: res.poolOverride, fallback: res.fallback },
        note: `rented rig #${intent.rigId} -> rental ${res.mrrId} (${res.poolOverride})`,
      });
      executed.push({ mrr_id: res.mrrId, rig_id: intent.rigId, rig_name: intent.rigName, region: intent.region,
        advertised_th: intent.advertisedTh, length_hours: intent.lengthHours, paid_sats: intent.paidSats, fee_sats: intent.feeSats });
      spent += cost; fee += intent.feeSats;
    }

    // Re-pack clean-failure shortfall from the next candidates (bounded rounds).
    round += 1;
    if (halted || !shortfallTh || round > REPACK_ROUNDS) break;
    intents = repackShortfall(stored, attempted, shortfallTh).filter((i) => !attempted.has(i.rigId));
    if (intents.length) {
      insertDecision(conn, sessionId, dryRun, { note: `re-pack round ${round}: ${intents.length} rig(s) to cover ${shortfallTh.toFixed(2)} TH shortfall` });
    }
  }

  const targetTh = stored.result.targetTh;
  const gotTh = (dryRun ? planned : executed).reduce((s, r) => s + r.advertised_th, 0);
  return {
    dry_run: dryRun,
    quote_id: stored.id,
    endpoint: { host: endpoint.host, port: endpoint.port, stratum: endpoint.stratum },
    target_th: targetTh,
    duration_hours: stored.result.durationHours,
    planned,
    executed,
    halted,
    halt_reason: haltReason,
    shortfall_th: Math.max(0, targetTh - gotTh),
    total_sats: spent,
    fee_sats: fee,
  };
}

/**
 * Feasibility estimate for an autopilot session at the current market: which cheapest rigs
 * would cover the target, the fee-inclusive sats/hour to HOLD it, and the projected runway
 * (budget / burn). Pure-ish (fetches the market). The runway vs the time cap tells the user
 * whether the budget or the clock ends the session.
 */
async function estimateAutopilot(conn, client, { targetTh, budgetSats, endpoint }) {
  const strat = config.get(conn, 'strategy');
  const rigs = await market.fetchAllRigs(client);
  const cands = quote.candidates(rigs, {
    mode: 'autopilot', minRpi: strat.min_rpi, blacklist: strat.blacklist_rig_ids,
    stabilityTolerancePct: strat.stability_tolerance_pct,
    endpointDiff: endpoint ? endpoint.stratum_diff : null,
  });
  // Pack to the target with the SAME overshoot-bounded packer the live decide loop uses, so the
  // preview reflects what execution will actually rent — a small target is never "held" by a giant
  // rig (which inflated rigCount/coveredTh/burn/runway ~6x before this). costOf uses each rig's
  // fee-inclusive minimum commit, so the budget only gates affordability here.
  const fitTol = (strat.fit_tolerance_pct != null ? strat.fit_tolerance_pct : 20) / 100;
  const maxOvershoot = (strat.max_overshoot_pct != null ? strat.max_overshoot_pct : 50) / 100;
  // Pack to the target WITHOUT a budget constraint. The cost to HOLD a target is a market property,
  // so burn / rate / rig set must not shift with the budget — otherwise the affordability filter
  // reshuffles the selection and runway (= budget / burn) goes non-monotonic (a bigger budget could
  // show a SHORTER runway). The budget only enters below, as the runway divisor.
  // coveredTh is EXPECTED DELIVERED TH (coverage is delivery-weighted), so the preview reflects the
  // hashrate you'll actually hold, not headline advertised numbers.
  const { selection, coveredTh } = decide.packToTarget(cands, targetTh, { fitTol, maxOvershoot, budgetRemaining: Infinity, costOf: () => 0 });
  const burnBtcHr = selection.reduce((s, r) => s + r.hourBtc, 0);
  const burnSatsHr = Math.round(burnBtcHr * 1e8 * (1 + quote.FEE_RATE));   // fee-incl sats/hr to hold target
  const runwayHours = burnSatsHr > 0 ? budgetSats / burnSatsHr : Infinity;
  // Blended pay-rate (sats/PH·day), advertised-TH-weighted like the market chart's "you" line, so the
  // preview is directly comparable to the cheapest / last-10 market rates. Raw rig rate (no fee), to
  // match those market references. 1e11 = BTC/TH·day -> sats/PH·day.
  const advTh = selection.reduce((s, r) => s + r.advertisedTh, 0);
  const costRateBtcDay = selection.reduce((s, r) => s + (r.priceBtcThDay || 0) * r.advertisedTh, 0);
  const blendedSatsPhDay = advTh > 0 ? Math.round((costRateBtcDay / advTh) * 1e11) : null;
  return {
    eligibleRigs: cands.length,   // any autopilot-eligible rigs at all — the "can we start" signal
    rigCount: selection.length,
    coveredTh,
    shortfallTh: Math.max(0, targetTh - coveredTh),
    burnSatsHr,
    blendedSatsPhDay,
    // Suggested cap = estimated blend + headroom, so the pre-filled ceiling gives the live fill room
    // instead of strangling it at the estimate. Shown to the user (editable), not enforced silently.
    suggestedCeilingSatsPhDay: blendedSatsPhDay != null ? Math.round(blendedSatsPhDay * CEILING_HEADROOM) : null,
    runwayHours: Number.isFinite(runwayHours) ? Math.round(runwayHours * 10) / 10 : null,
  };
}

/**
 * Open an autopilot session. Unlike a quick rent it creates NO rentals synchronously: the
 * control loop fills and maintains the target by renting at each rig's min length and
 * re-renting on expiry, which spreads spend across the time cap (a single long up-front rent
 * would exhaust a long session's budget in the first rental). In DRY-RUN the loop only
 * rehearses; going LIVE is the explicit opt-in to autonomous spend within the ceilings.
 */
async function startAutopilotSession(conn, client, params = {}) {
  if (starting) throw new SessionError('session_in_progress');
  starting = true;
  try {
    if (conn.prepare("SELECT id FROM sessions WHERE state IN ('active', 'winding_down')").get()) throw new SessionError('session_active');

    const targetTh = Number(params.targetTh);
    const timeCapHours = Number(params.timeCapHours);
    const budgetSats = Math.round(Number(params.budgetSats));
    if (!(targetTh > 0)) throw new SessionError('bad_target');
    if (!(timeCapHours > 0)) throw new SessionError('bad_time_cap');
    if (!(budgetSats > 0)) throw new SessionError('bad_budget');

    const cap = config.getKey(conn, 'guardrails', 'max_session_budget_sats');
    if (cap != null && budgetSats > cap) throw new SessionError('exceeds_guardrail');

    const endpoint = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!endpoint || !endpoint.mrr_profile_id) throw new SessionError('no_endpoint');

    const estimate = await estimateAutopilot(conn, client, { targetTh, budgetSats, endpoint });
    // Start when ANY autopilot-eligible rig exists — not when the bounded pack happens to fit the
    // target this instant. If only oversized rigs are up, decide holds what fits and fills the rest
    // as the market shifts, rather than over-provisioning at start or refusing a workable session.
    if (!estimate.eligibleRigs) throw new SessionError('no_rigs_available');

    const info = conn.prepare(
      `INSERT INTO sessions (mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('autopilot', 'active', ?, ?, ?, 0, 0, ?, ?)`,
    ).run(targetTh, budgetSats, timeCapHours, nowSec(), nowSec());

    // Persist the blended ceiling from the preview only now that the session is committed — a start
    // that bailed earlier (no endpoint / no rigs) must not have changed the standing guardrail. The
    // value is the max blended pay-rate ("you" line) in sats/PH·day; blank/0 clears it, an absent key
    // leaves the setting untouched.
    if (params.blendedCeilingSatsPhDay !== undefined) {
      const phDay = Number(params.blendedCeilingSatsPhDay);
      const ceil = Number.isFinite(phDay) && phDay > 0 ? Math.round(phDay) : null;
      config.set(conn, 'guardrails', { blended_ceiling_sats_ph_day: ceil });
    }

    return {
      session_id: Number(info.lastInsertRowid),
      mode: 'autopilot', target_th: targetTh, budget_sats: budgetSats, time_cap_hours: timeCapHours,
      estimate,
    };
  } finally {
    starting = false;
  }
}

/**
 * Stop the current session. If it holds no live rentals (a rehearsal, or a session whose
 * rentals have all expired) it ENDS immediately so a new one can start. If paid rentals are
 * still running, MRR time can't be cancelled — so it WINDS DOWN: autopilot stops topping up
 * (decide only acts on 'active'), the engine keeps monitoring the paid rentals, and the
 * session closes itself once they expire. A new session stays blocked until then.
 *
 * When it ends immediately, it reconciles the close against MRR's ledger IF a client is given —
 * matching the natural runLifecycle close. Without one it falls back to recorded amounts (safe),
 * but since state becomes 'ended' the tick loop never revisits it, so the API passes a client so a
 * stopped session isn't permanently stuck on recorded-only numbers.
 */
async function stopSession(conn, client = null) {
  const s = conn.prepare("SELECT * FROM sessions WHERE state IN ('active', 'winding_down') ORDER BY id DESC LIMIT 1").get();
  if (!s) return { stopped: false, reason: 'no_active_session' };
  const live = conn.prepare('SELECT COUNT(*) AS c FROM rentals WHERE session_id = ? AND ended = 0').get(s.id).c;
  if (live > 0) {
    conn.prepare("UPDATE sessions SET state = 'winding_down' WHERE id = ?").run(s.id);
    return { stopped: true, state: 'winding_down', active_rentals: live };
  }
  const rentals = conn.prepare('SELECT * FROM rentals WHERE session_id = ?').all(s.id);
  const ledger = await ledgerFetch.fetchSessionLedger(client, s);
  const summary = accounting.buildSummary({ session: s, rentals, ledger });
  conn.prepare("UPDATE sessions SET state = 'ended', ended_at = ?, summary_json = ?, spent_sats = ?, fee_sats = ? WHERE id = ?")
    .run(nowSec(), JSON.stringify(summary), summary.spent_sats, summary.fee_sats, s.id);
  return { stopped: true, state: 'ended' };
}

module.exports = { startSession, startAutopilotSession, estimateAutopilot, stopSession, executeSession, planIntents, rentOne, persistRental, insertDecision, repackShortfall, rateCapPhDay, SessionError, OCEAN_FALLBACK, oceanFallbackWorker };
