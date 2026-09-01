'use strict';
/*
 * Autopilot execute — perform the gate's authorized rents (or record its DRY-RUN would-do),
 * reusing session.js's proven single-rental path: create + per-rental worker override +
 * ambiguous-outcome handling + persist + decision audit. It NEVER retries an ambiguous
 * create (we may already have been billed for a rental we can't address) — it records a
 * needs_reconcile orphan and stops for this tick, leaving reconciliation to a later tick.
 *
 * The session's spent_sats/fee_sats are advanced as rentals are created so the gate's
 * budget checks see the live cumulative spend on the very next tick (no overspend window).
 */
const { rentOne, persistRental, insertDecision, resolveFallbackPool } = require('../session');
const { MrrAmbiguousError } = require('../mrr-client');
const alerts = require('../alerts');
const config = require('../config');

function cost(a) { return (a.paidSats || 0) + (a.feeSats || 0); }

/**
 * @param {object} conn  DB handle
 * @param {object} client  MRR client (null-safe: callers only pass one in LIVE)
 * @param {object} ctx  { sessionId, endpoint, gateResult }
 * @returns { executed, rehearsed, halted, haltReason }
 */
async function execute(conn, client, ctx) {
  const { sessionId, endpoint, gateResult } = ctx;
  const executed = [];
  const rehearsed = [];
  let halted = false;
  let haltReason = null;

  // DRY-RUN rehearsal: record each would-do as a decision; mutate nothing.
  for (const a of gateResult.wouldDo || []) {
    insertDecision(conn, sessionId, true, {
      proposed: { rig: a.rigId, length: a.lengthHours, rate_cap_unit_day: a.rateCapUnitDay, price_unit: a.priceUnit },
      executed: { would_rent: true, rig: a.rigId, length: a.lengthHours, cost_sats: cost(a) },
      note: `AUTOPILOT DRY-RUN would rent rig #${a.rigId} (${a.rigName}) for ${a.lengthHours}h at ${cost(a)} sats`,
    });
    rehearsed.push(a);
  }

  // LIVE: perform each authorized rent (the gate already capped to one/tick + all ceilings).
  // Ocean safety-net at rental priority 1 — same knob the manual path honors (session.js). Autopilot
  // creates nearly all rentals in practice, so without this the fallback would never actually attach.
  const fallbackPool = resolveFallbackPool(conn);
  for (const a of gateResult.authorized || []) {
    // Intent-first audit row — the reconciliation anchor if we crash mid-create.
    insertDecision(conn, sessionId, false, {
      proposed: { rig: a.rigId, length: a.lengthHours, rate_cap_unit_day: a.rateCapUnitDay, price_unit: a.priceUnit, worker_base: endpoint.worker_base },
      note: 'autopilot intent',
    });
    let res;
    try {
      res = await rentOne(client, a, endpoint, { fallbackPool });
    } catch (e) {
      if (e instanceof MrrAmbiguousError) {
        insertDecision(conn, sessionId, false, { executed: { ambiguous: true, rig: a.rigId }, note: 'ambiguous_halt: autopilot create outcome unknown — not retried, reconcile next tick' });
        alerts.raiseReconcile(conn, { key: `sess${sessionId}rig${a.rigId}`, now: Date.now(), context: { rig: a.rigId, name: a.rigName } });
        halted = true; haltReason = 'ambiguous';
        break;
      }
      // Clean failure (rig taken / repriced): record and move on — next tick re-decides.
      insertDecision(conn, sessionId, false, { executed: { failed: true, rig: a.rigId, error: e.name }, note: `autopilot rig_failed: ${e.name}` });
      continue;
    }
    persistRental(conn, sessionId, a, res);
    conn.prepare('UPDATE sessions SET spent_sats = COALESCE(spent_sats, 0) + ?, fee_sats = COALESCE(fee_sats, 0) + ? WHERE id = ?')
      .run(cost(a), a.feeSats || 0, sessionId);
    insertDecision(conn, sessionId, false, {
      executed: { mrr_id: res.mrrId, rig: a.rigId, worker: res.worker, pool_override: res.poolOverride, fallback: res.fallback },
      note: `autopilot rented rig #${a.rigId} -> rental ${res.mrrId} (${res.poolOverride}, fallback ${res.fallback})`,
    });
    executed.push({ mrr_id: res.mrrId, rig_id: a.rigId, advertised_th: a.advertisedTh, paid_sats: a.paidSats, fee_sats: a.feeSats });
  }

  return { executed, rehearsed, halted, haltReason };
}

module.exports = { execute };
