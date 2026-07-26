'use strict';
/*
 * Optional courtesy nudge. When a rented rig SUSTAINS under-delivery (a rental_underdelivering
 * alert has fired — already past the health debounce), send the rig owner a single polite templated
 * message so they can check it. Strictly opt-in (strategy.owner_nudge_enabled, default OFF), at most
 * once per rental, at most one per tick, and run-mode aware: DRY-RUN records a would-send and sends
 * nothing; LIVE sends. Every outcome is logged to `decisions`. This is NEVER a spend.
 */
const config = require('../config');

/** The templated message body (plain text; MRR renders it, and the owner is the recipient). */
function templateFor(rental) {
  const pct = rental.avg_percent != null ? `~${Math.round(rental.avg_percent)}%` : 'well under 100%';
  return `Hi — automated note from a renter. Your rig "${rental.rig_name}" has been delivering ${pct} of its advertised hashrate on rental #${rental.mrr_id}. Could you take a look when you get a chance? Thanks!`;
}

/**
 * Already handled this rental IN THIS MODE? Dedup is per-mode so a DRY-RUN rehearsal (which sends
 * nothing) does NOT suppress a later LIVE send — mirroring how a dry-run "would rent" never blocks a
 * live rent. A live 'sent' is once-per-rental; a dry-run 'dry_run' is once-per-rental-per-rehearsal.
 */
function attempted(conn, mrrId, dryRun) {
  return !!conn.prepare('SELECT 1 FROM decisions WHERE note = ?').get(`owner_nudge:${mrrId}:${dryRun ? 'dry_run' : 'sent'}`);
}

/**
 * At most one nudge per tick. Best-effort: a send failure writes no marker so it retries next tick.
 * Returns a small summary for the engine log.
 */
async function maybeNudge(conn, client, opts = {}) {
  const nowSec = Math.floor((opts.now || Date.now()) / 1000);
  if (!config.getKey(conn, 'strategy', 'owner_nudge_enabled')) return { ran: false, reason: 'disabled' };

  // A rig delivering ~0% confirms OFFLINE (not degraded), so it fires rental_offline, not
  // rental_underdelivering — nudge on BOTH sustained-bad alerts (a dead rig is the most nudge-worthy).
  const fired = conn.prepare("SELECT DISTINCT key FROM alerts WHERE kind IN ('rental_underdelivering','rental_offline') AND state = 'fired'").all().map((a) => String(a.key));
  const dryRun = (config.getKey(conn, 'run', 'mode') || 'dry-run') !== 'live';
  const mark = (mrrId, note) => conn.prepare('INSERT INTO decisions (ts, session_id, dry_run, note) VALUES (?, ?, ?, ?)')
    .run(nowSec, null, dryRun ? 1 : 0, `owner_nudge:${mrrId}:${note}`);

  for (const mrrId of fired) {
    if (attempted(conn, mrrId, dryRun)) continue;
    // A rerouted rig already got a (more specific) owner message from dead-rig fallback — don't
    // double-message it.
    const rental = conn.prepare('SELECT * FROM rentals WHERE mrr_id = ? AND ended = 0 AND rerouted_ocean = 0').get(mrrId);
    if (!rental) continue;
    if (dryRun) { mark(mrrId, 'dry_run'); return { ran: true, decided: 'dry_run', mrr_id: Number(mrrId) }; }
    if (!client) return { ran: false, reason: 'no_client' };
    try {
      await client.put(`/rental/${mrrId}/message`, { message: templateFor(rental) });
      mark(mrrId, 'sent');
      return { ran: true, decided: 'sent', mrr_id: Number(mrrId) };
    } catch { return { ran: false, reason: 'send_failed' }; }   // no marker -> retry next tick
  }
  return { ran: false, reason: 'no_candidate' };
}

module.exports = { maybeNudge, templateFor, attempted };
