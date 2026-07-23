'use strict';
/*
 * Spend accounting + refund reconciliation. Pure.
 *
 * Money is reconciled against MRR's OWN `account/transactions` ledger, never our
 * arithmetic (a missing ledger row is a flagged discrepancy, not silent drift). A session
 * summary is provisional: refunds land hours-to-days after close and lower the effective
 * cost, so History always reads the latest reconciled numbers.
 */
const SATS = 1e8;
const sats = (btc) => Math.round(Number(btc) * SATS);

/** Sum Payment + Rental Fee ledger rows for a session's rentals; flag rentals with no row. */
function reconcileSpend(rentals, ledgerRows) {
  const ids = new Set(rentals.map((r) => String(r.mrr_id)));
  const byRental = {};
  let paidSats = 0;
  let feeSats = 0;
  for (const t of ledgerRows || []) {
    if (!ids.has(String(t.rental))) continue;
    const amt = Math.abs(sats(t.amount));
    byRental[t.rental] = byRental[t.rental] || { paid: 0, fee: 0 };
    if (t.type === 'Payment') { paidSats += amt; byRental[t.rental].paid += amt; }
    else if (t.type === 'Rental Fee') { feeSats += amt; byRental[t.rental].fee += amt; }
  }
  // Only flag a discrepancy when we ACTUALLY fetched a ledger — an empty ledger means we
  // didn't check, not that every rental is missing its Payment row.
  const missing = (ledgerRows && ledgerRows.length)
    ? rentals.filter((r) => (r.paid_sats || 0) > 0 && !(byRental[r.mrr_id] && byRental[r.mrr_id].paid > 0)).map((r) => r.mrr_id)
    : [];
  return { paidSats, feeSats, byRental, missing };
}

/**
 * Match CREDIT refund ledger rows to rentals by mrr_id. Idempotent: a transaction id
 * already in `seenTxIds` is skipped (no double-count). A `debit/refund` row is a reversal/
 * clawback going the OTHER way — it is never summed as a positive refund here, so a
 * refund-then-reversal can't net to 2×. This invariant holds in the pure function itself,
 * not only in the caller's ledger query.
 */
function matchRefunds(rentals, refundRows, seenTxIds = new Set()) {
  const byId = Object.fromEntries(rentals.map((r) => [String(r.mrr_id), r]));
  const matches = [];
  for (const t of refundRows || []) {
    const txId = String(t.id);
    if (seenTxIds.has(txId)) continue;
    const type = t.type || '';
    if (!/refund/i.test(type) || /debit/i.test(type)) continue;
    const r = byId[String(t.rental)];
    if (!r) continue;
    matches.push({ mrr_id: r.mrr_id, refund_sats: Math.abs(sats(t.amount)), tx_id: txId });
    seenTxIds.add(txId);   // dedup WITHIN this batch too (the same tx must not match twice)
  }
  return matches;
}

/** Delivered TH·hours for a rental (advertised × delivered% × length). */
function deliveredThHours(r) {
  const pct = r.avg_percent != null ? r.avg_percent / 100 : 0;
  return (r.advertised_th || 0) * pct * (r.length_hours || 0);
}

/**
 * Session summary. Reconciles against the ledger when present, else falls back to our
 * recorded per-rental paid/fee. Effective cost is per TH·day *delivered*, net of refunds.
 */
function buildSummary({ session, rentals, ledger }) {
  const rec = reconcileSpend(rentals, ledger);
  const refundSats = (rentals || []).reduce((s, r) => s + (r.refund_sats || 0), 0);
  // Gross is reconciled PER RENTAL: use the ledger row when this rental has one, else fall
  // back to its recorded paid+fee. A whole-session `||` fallback would drop the recorded
  // spend of any rental whose Payment row hasn't posted yet when a partial ledger is present.
  const grossOf = (r) => {
    const led = rec.byRental[r.mrr_id];
    return led ? led.paid + led.fee : (r.paid_sats || 0) + (r.fee_sats || 0);
  };
  const feeOf = (r) => {
    const led = rec.byRental[r.mrr_id];
    return led ? led.fee : (r.fee_sats || 0);
  };
  const grossSats = (rentals || []).reduce((s, r) => s + grossOf(r), 0);
  const spentSats = grossSats - refundSats;
  const thHours = (rentals || []).reduce((s, r) => s + deliveredThHours(r), 0);
  const thDays = thHours / 24;
  return {
    session_id: session ? session.id : null,
    gross_sats: grossSats,
    refund_sats: refundSats,
    spent_sats: spentSats,
    fee_sats: (rentals || []).reduce((s, r) => s + feeOf(r), 0),
    delivered_th_hours: thHours,
    effective_sats_per_th_day: thDays > 0 ? spentSats / thDays : null,
    per_rig: (rentals || []).map((r) => ({
      rig_id: r.rig_id, name: r.rig_name, advertised_th: r.advertised_th,
      // Use the SAME ledger-preferring gross as the session total, so the per-rig breakdown sums
      // to gross_sats (a recorded cost_sats would diverge whenever the ledger reconciled higher).
      avg_percent: r.avg_percent, cost_sats: grossOf(r), refund_sats: r.refund_sats || 0,
    })),
    ledger_discrepancy: rec.missing.length ? rec.missing : null,
  };
}

module.exports = { reconcileSpend, matchRefunds, deliveredThHours, buildSummary, sats };
