'use strict';
/*
 * Proactive dead-rig fallback. When a rented rig SUSTAINS offline (a rental_offline alert has fired
 * — already past health's ~10-min debounce, so it's genuinely not mining) WHILE the pool endpoint
 * itself is healthy (endpoint_down not fired), the trouble is that ONE rig, not the pool: it connects
 * and takes the initial difficulty but never submits shares. Reroute just that rental to the Ocean
 * fallback pool so its purchased hashrate isn't wasted, and message the owner so there's a timestamped
 * record on the rental (and a chance for them to fix it).
 *
 * The pool override is PER-RENTAL (keyed by mrr_id), so peers keep mining to your node untouched.
 * Rerouting a paid rental isn't a spend but IS an MRR mutation + an owner message, so it's strictly
 * opt-in (strategy.dead_rig_reroute_enabled, default OFF), requires the Ocean fallback to be enabled,
 * run-mode aware (DRY-RUN records a would-do and mutates nothing), at most one rig per tick, and once
 * per rental (the rerouted_ocean flag). endpoint-repair and owner-nudge both skip a rerouted rental,
 * so nothing yanks its pool/0 back or double-messages the owner.
 */
const config = require('../config');
const alerts = require('../alerts');
const session = require('../session');   // OCEAN_FALLBACK + oceanFallbackWorker (shared with rent-time setup)

/** The owner notice (plain text; MRR renders it, the rig owner is the recipient). */
function ownerMessage(rental) {
  return `Hi — automated note from a renter. Your rig "${rental.rig_name}" connected to my pool on rental #${rental.mrr_id} but isn't submitting shares — it takes the initial difficulty, then no jobs register and it shows offline — while my other rented rigs are mining normally on the same pool at the same time. To keep it earning rather than sitting idle, I've switched this rental to a backup public pool (Ocean). If it starts hashing there, the cause is almost certainly a setting on the rig itself — often a "minimum/starting difficulty" set higher than the pool's initial difficulty, or a non-standard version-rolling/AsicBoost mode. Happy to help however I can — thanks!`;
}

/**
 * At most one reroute per tick. Best-effort: a reroute PUT failure writes no marker so it retries
 * next tick; a message failure still leaves the reroute recorded (the pool move is the point).
 * Returns a small summary for the engine log.
 */
async function maybeReroute(conn, client, snapshot, opts = {}) {
  const nowMs = opts.now || Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  if (!config.getKey(conn, 'strategy', 'dead_rig_reroute_enabled')) return { ran: false, reason: 'disabled' };
  if (!config.getKey(conn, 'strategy', 'fallback_pool_enabled')) return { ran: false, reason: 'no_fallback_pool' };
  // Only when the pool endpoint is healthy. If it's down, EVERY rig goes offline — that's an endpoint
  // problem (endpoint-repair / MRR's own failover), not a per-rig one, and rerouting each individually
  // would be exactly wrong.
  if (alerts.newRentsHalted(conn)) return { ran: false, reason: 'endpoint_down' };

  const endpoint = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!endpoint) return { ran: false, reason: 'no_endpoint' };

  const offline = conn.prepare("SELECT DISTINCT key FROM alerts WHERE kind = 'rental_offline' AND state = 'fired'").all().map((a) => String(a.key));
  const dryRun = (config.getKey(conn, 'run', 'mode') || 'dry-run') !== 'live';
  const mark = (rental, note) => conn.prepare('INSERT INTO decisions (ts, session_id, dry_run, note) VALUES (?, ?, ?, ?)')
    .run(nowSec, rental.session_id, dryRun ? 1 : 0, `reroute_ocean:${rental.mrr_id}:${note}`);

  for (const mrrId of offline) {
    const rental = conn.prepare('SELECT * FROM rentals WHERE mrr_id = ? AND ended = 0 AND rerouted_ocean = 0').get(mrrId);
    if (!rental) continue;
    if (dryRun) { mark(rental, 'dry_run'); return { ran: true, decided: 'dry_run', mrr_id: Number(mrrId) }; }
    if (!client) return { ran: false, reason: 'no_client' };
    const worker = session.oceanFallbackWorker(endpoint.worker_base);
    try {
      // Promote Ocean to THIS rental's primary pool. Per-rental, so peers are untouched.
      await client.put(`/rental/${mrrId}/pool/0`, { host: session.OCEAN_FALLBACK.host, port: session.OCEAN_FALLBACK.port, user: worker, pass: 'x', priority: 0 });
    } catch { return { ran: false, reason: 'reroute_failed' }; }   // no marker -> retry next tick
    // Mark rerouted BEFORE the (best-effort) owner message: a message failure must never re-reroute.
    conn.prepare('UPDATE rentals SET rerouted_ocean = 1 WHERE mrr_id = ?').run(mrrId);
    let messaged = false;
    try { await client.put(`/rental/${mrrId}/message`, { message: ownerMessage(rental) }); messaged = true; }
    catch { /* the reroute itself stands; the message just didn't send */ }
    mark(rental, 'done');
    alerts.fireOnce(conn, {
      kind: 'rig_rerouted', key: String(mrrId), now: nowMs,
      context: { mrr_id: Number(mrrId), rig: rental.rig_id, name: rental.rig_name, to: 'ocean', messaged },
    });
    return { ran: true, decided: 'rerouted', mrr_id: Number(mrrId), messaged };
  }
  return { ran: false, reason: 'no_candidate' };
}

module.exports = { maybeReroute, ownerMessage };
