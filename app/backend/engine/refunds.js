'use strict';
/*
 * Post-session refund reconciliation.
 *
 * MRR underperformance refunds are prorated and processed AFTER a rental ends — hours to
 * days later — so a session summary is provisional. Every ended rental joins a watch list
 * for `refund_watch_days`; while watched, we pull the refund ledger, match rows to rentals
 * by mrr_id (accounting.matchRefunds, pure + tested), and on a match record the refund,
 * recompute the parent session's spend/effective-cost from the reconciled numbers, and
 * fire `refund_received`. Idempotent: each transaction id is applied once (applied_refunds).
 */
const accounting = require('./accounting');
const ledger = require('./ledger');
const alerts = require('../alerts');

const DAY = 86400;
const REFUND_CADENCE_MS = 10 * 60 * 1000;   // piggyback cadence — not every tick

/** Arm the watch window on rentals that have ended but aren't yet being watched. */
function armWatch(conn, refundWatchDays) {
  conn.prepare(
    'UPDATE rentals SET refund_watch_until = end_ts + ? WHERE ended = 1 AND refund_watch_until IS NULL AND end_ts IS NOT NULL',
  ).run(refundWatchDays * DAY);
}

/**
 * Recompute a session's spend/summary from its rentals (net of refunds). Re-fetches the account
 * ledger so a refund landing after close doesn't discard the close-time reconciliation (revert
 * gross to recorded and clear a real ledger_discrepancy). Blip-safe: [] ledger -> recorded.
 */
async function recomputeSession(conn, sessionId, client) {
  const s = conn.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) return;
  const rentals = conn.prepare('SELECT * FROM rentals WHERE session_id = ?').all(sessionId);
  const led = await ledger.fetchSessionLedger(client, s);
  const summary = accounting.buildSummary({ session: s, rentals, ledger: led });
  conn.prepare('UPDATE sessions SET spent_sats = ?, summary_json = ? WHERE id = ?')
    .run(summary.spent_sats, JSON.stringify(summary), sessionId);
}

/**
 * Poll + apply refunds for currently-watched rentals. Impure (reads the MRR ledger).
 * Returns fired `refund_received` events. Blip-safe: a failed ledger fetch is a no-op.
 */
async function reconcile(conn, client, nowSec, refundWatchDays) {
  armWatch(conn, refundWatchDays);
  const watched = conn.prepare(
    'SELECT * FROM rentals WHERE ended = 1 AND refund_watch_until IS NOT NULL AND refund_watch_until >= ?',
  ).all(nowSec);
  if (!watched.length) return [];

  const since = Math.min(...watched.map((r) => r.end_ts || nowSec));
  let rows;
  try {
    // Only credit/refund — an unambiguous refund back to us. debit/refund (a reversal/
    // clawback going the other way) isn't summed until its ledger direction is verified
    // live, so a refund-then-reversal can't net to 2× the amount.
    const a = await client.get('/account/transactions', { type: 'credit/refund', time_greater_eq: since, limit: 100 });
    rows = (a && a.transactions) || [];
  } catch { return []; }

  const seen = new Set(conn.prepare('SELECT tx_id FROM applied_refunds').all().map((r) => String(r.tx_id)));
  const matches = accounting.matchRefunds(watched, rows, seen);
  const events = [];
  const touchedSessions = new Set();
  for (const m of matches) {
    // Gate the money mutation on the idempotency insert ACTUALLY happening — never double-
    // credit a tx that's already applied.
    const info = conn.prepare('INSERT OR IGNORE INTO applied_refunds (tx_id, rental_mrr_id, sats, applied_at) VALUES (?, ?, ?, ?)')
      .run(m.tx_id, m.mrr_id, m.refund_sats, nowSec);
    if (info.changes === 0) continue;
    conn.prepare('UPDATE rentals SET refund_sats = COALESCE(refund_sats, 0) + ?, refunded = 1 WHERE mrr_id = ?')
      .run(m.refund_sats, m.mrr_id);
    const row = conn.prepare('SELECT session_id FROM rentals WHERE mrr_id = ?').get(m.mrr_id);
    if (row) touchedSessions.add(row.session_id);
    const ev = alerts.fireOnce(conn, { kind: 'refund_received', key: `tx${m.tx_id}`, now: nowSec * 1000, context: { rental: m.mrr_id, sats: m.refund_sats } });
    if (ev) events.push(ev);
  }
  for (const sid of touchedSessions) await recomputeSession(conn, sid, client);
  return events;
}

module.exports = { reconcile, armWatch, recomputeSession, REFUND_CADENCE_MS };
