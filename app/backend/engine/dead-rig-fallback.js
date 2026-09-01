'use strict';
/*
 * Proactive dead-rig fallback. When a rented rig SUSTAINS offline (a rental_offline alert has fired —
 * past health's offline debounce, ~5 min on the MRR source, so it's genuinely not mining) WHILE the
 * pool endpoint itself is healthy (endpoint_down not fired) and other rented rigs are delivering, the
 * trouble is that ONE rig, not the pool: it isn't returning any hashrate. Reroute just that rental to
 * the Ocean fallback pool so its purchased hashrate isn't wasted, and message the owner so there's a
 * timestamped record on the rental (and a chance for them to fix it).
 *
 * The pool override is PER-RENTAL (keyed by mrr_id), so peers keep mining to your node untouched.
 * Rerouting a paid rental isn't a spend but IS an MRR mutation + an owner message, so it's strictly
 * opt-in (strategy.dead_rig_reroute_enabled, default OFF), requires the Ocean fallback to be enabled,
 * run-mode aware (DRY-RUN records a would-do and mutates nothing), at most one rig per tick, and once
 * per rental (the rerouted_ocean flag). endpoint-repair and owner-nudge both skip a rerouted rental,
 * so nothing yanks its pool/0 back or double-messages the owner.
 */
const config = require('../config');
const market = require('../market');
const alerts = require('../alerts');
const session = require('../session');   // OCEAN_FALLBACK + oceanFallbackWorker (shared with rent-time setup)

/**
 * The owner notice (plain text; MRR renders it, the rig owner is the recipient). Every factual claim
 * here must be provable from what we observe, so it holds up if the owner or MRR checks:
 *  - "returning 0% of its advertised hashrate" / "no shares registering": from the rental's offline
 *    health + ~0% avg_percent (a pool measures rented hashrate BY accepted shares, so 0% delivered is
 *    exactly "no shares accepted"). We deliberately do NOT claim anything about jobs the pool sends —
 *    the pool sends jobs fine (the peers below are receiving them), so that would be false.
 *  - "for a sustained period": rental_offline only fires past health's offline debounce (~5 min on the
 *    MRR source). We do NOT assert a specific minute count — the debounce varies by source.
 *  - "N other rig(s) ... mining normally on the same pool right now": the caller only sends this when
 *    it has verified >= 1 peer rental currently health='healthy' AND still on your pool (not itself
 *    already parked on Ocean) — see the healthyPeers query.
 * The firmware cause is framed as a possibility ("in similar cases"), not asserted — we can't see it.
 */
function ownerMessage(rental, { healthyPeers } = {}) {
  const n = healthyPeers || 0;
  const peers = n === 1 ? 'another rig I\'m currently renting is mining normally' : `${n} other rigs I'm currently renting are mining normally`;
  return `Hi — automated note from a renter. Your rig "${rental.rig_name}" (rental #${rental.mrr_id}) has been showing offline — returning 0% of its advertised hashrate, i.e. no shares registering on the pool — for a sustained period, while ${peers} on the same pool right now. Since the pool is clearly serving those, I've switched this rental to a backup public pool (Ocean) so your rig's time isn't wasted while it's stuck. If it starts hashing there, the cause is likely something on the rig's side — in similar cases it's been a "minimum/starting difficulty" set higher than the pool's, or a non-standard version-rolling/AsicBoost mode — but you'll know your setup best. Happy to help — thanks!`;
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
  const mark = (rental, note) => conn.prepare('INSERT INTO decisions (algo, ts, session_id, dry_run, note) VALUES (?, ?, ?, ?, ?)')
    .run(market.activeAlgo(conn), nowSec, rental.session_id, dryRun ? 1 : 0, `reroute_ocean:${rental.mrr_id}:${note}`);

  let sawNoPeer = false;
  for (const mrrId of offline) {
    const rental = conn.prepare('SELECT * FROM rentals WHERE mrr_id = ? AND ended = 0 AND rerouted_ocean = 0').get(mrrId);
    if (!rental) continue;
    // Reroute ONLY with positive proof the pool is fine and it's this rig: at least one OTHER rig on
    // YOUR pool is mining normally (health='healthy') right now. Exclude rigs already parked on Ocean
    // (rerouted_ocean=1) — one recovering ON OCEAN is not evidence YOUR pool serves jobs, and the owner
    // message claims "on the same pool", so counting it would make that claim false. A rented peer
    // delivering is far stronger evidence than our own endpoint probe; without it we neither reroute nor
    // message (MRR's normal offline handling still applies). Also means an all-rigs-offline endpoint
    // problem never trips it.
    const healthyPeers = conn.prepare("SELECT COUNT(*) AS n FROM rentals WHERE session_id = ? AND ended = 0 AND rerouted_ocean = 0 AND mrr_id != ? AND health = 'healthy'").get(rental.session_id, mrrId).n;
    if (!healthyPeers) { sawNoPeer = true; continue; }
    if (dryRun) {
      // Dedup the rehearsal so a dry-run soak doesn't append a decision row every tick (mirrors
      // owner-nudge). rerouted_ocean is only set in LIVE, so we key off the recorded decision instead.
      if (conn.prepare('SELECT 1 FROM decisions WHERE note = ?').get(`reroute_ocean:${mrrId}:dry_run`)) continue;
      mark(rental, 'dry_run'); return { ran: true, decided: 'dry_run', mrr_id: Number(mrrId) };
    }
    if (!client) return { ran: false, reason: 'no_client' };
    const worker = session.oceanFallbackWorker(endpoint.worker_base);
    try {
      // Promote Ocean to THIS rental's primary pool. Per-rental, so peers are untouched.
      await client.put(`/rental/${mrrId}/pool/0`, { host: session.OCEAN_FALLBACK.host, port: session.OCEAN_FALLBACK.port, user: worker, pass: 'x', priority: 0 });
    } catch { return { ran: false, reason: 'reroute_failed' }; }   // no marker -> retry next tick
    // Mark rerouted BEFORE the (best-effort) owner message: a message failure must never re-reroute.
    conn.prepare('UPDATE rentals SET rerouted_ocean = 1 WHERE mrr_id = ?').run(mrrId);
    let messaged = false;
    try { await client.put(`/rental/${mrrId}/message`, { message: ownerMessage(rental, { healthyPeers }) }); messaged = true; }
    catch { /* the reroute itself stands; the message just didn't send */ }
    mark(rental, 'done');
    alerts.fireOnce(conn, {
      kind: 'rig_rerouted', key: String(mrrId), now: nowMs,
      context: { mrr_id: Number(mrrId), rig: rental.rig_id, name: rental.rig_name, to: 'ocean', messaged, healthy_peers: healthyPeers },
    });
    return { ran: true, decided: 'rerouted', mrr_id: Number(mrrId), messaged };
  }
  // An offline rig with no known-good peer isn't reroutable — we can't prove it's the rig vs the pool.
  return { ran: false, reason: sawNoPeer ? 'no_healthy_peer' : 'no_candidate' };
}

module.exports = { maybeReroute, ownerMessage };
