'use strict';
/*
 * Bring a live rental's stratum username back in line with the current naming rule.
 *
 * `worker_name` is written once, at creation, and every later re-point (DuckDNS, endpoint
 * repair) re-sends the stored string verbatim. So a rental created under an older rule
 * keeps that name for its whole paid duration, and upgrading Pickhash does nothing for
 * the rentals already running.
 *
 * That is expensive in one specific way. The old `<worker_base>-r<id>` form is accepted
 * by Ocean but not parsed by Convoy: the connection authorises, work is served, MRR
 * records full delivery — and the shares are credited to nobody, because the dash left
 * the pool with no address it could read. Nothing in the delivery path can see it. From
 * MRR's side the rental is healthy, so under-delivery never fires, no refund is due, and
 * the only symptom is hashrate missing from a pool dashboard the app never reads.
 *
 * Waiting for the next rental is therefore not good enough — the money is being spent
 * now. This re-points any active rental whose stored username is not what
 * `endpoints.rentalWorker` would produce today, carrying the stored password through so a
 * per-rig difficulty is not reset on the way past.
 *
 * Any mismatch, not just the old dash form: the same drift happens if the saved endpoint's
 * address changes under a running session, and that case has the identical symptom of
 * paying for hashrate credited to an address the user no longer uses. A rental on a pool
 * that was working keeps working — a worker rename costs a reconnect, and pools credit the
 * address, not the label.
 *
 * The same holds for the host: a rental whose recorded pool host:port is not the saved
 * endpoint's (the user saved a new tunnel, or an earlier re-point failed part-way) is moved
 * too. This is the one pass that brings every running rental in line with the saved
 * endpoint, so the other re-pointing paths (endpoint repair, DuckDNS) can be best-effort:
 * whatever they leave behind is picked up here on the next tick.
 */
const alerts = require('../alerts');
const market = require('../market');
const endpoints = require('../endpoints');

/**
 * Active rentals whose pool/0 username is stale, as {mrr_id, from, to, ...}. Pure read.
 *
 * Excludes rentals parked on the fallback pool by dead-rig fallback: those carry a
 * deliberate `.fallback` worker on a DIFFERENT pool, so they are not stale, and
 * "repairing" them would drag them back to the endpoint they were moved off.
 */
function planWorkerRepairs(conn, endpoint) {
  if (!endpoint || !endpoint.worker_base) return [];
  const rows = conn.prepare(
    `SELECT r.mrr_id, r.worker_name, r.stratum_pass, r.session_id, r.rig_name, r.pool_host, r.pool_port
       FROM rentals r JOIN sessions s ON s.id = r.session_id
      WHERE s.state IN ('active', 'winding_down') AND r.ended = 0 AND r.rerouted_ocean = 0`,
  ).all();
  const out = [];
  for (const r of rows) {
    const want = endpoints.rentalWorker(endpoint.worker_base, r.mrr_id);
    // A base with no address yields no name; there is nothing better to move to, so leave
    // the rental alone rather than re-point it at something emptier than what it has.
    if (!want) continue;
    // A pool host that is unknown (NULL: never recorded) is not evidence of a move, so only
    // a recorded host that differs from the saved endpoint counts.
    const hostMoved = r.pool_host != null
      && (String(r.pool_host) !== String(endpoint.host) || Number(r.pool_port) !== Number(endpoint.port));
    if (want !== r.worker_name || hostMoved) {
      out.push({
        ...r, from: r.worker_name, to: want,
        fromHost: r.pool_host, fromPort: r.pool_port, hostMoved,
      });
    }
  }
  return out;
}

/**
 * Impure: apply the plan. LIVE only — this is a real MRR mutation, and a DRY-RUN
 * rehearsal must not rewrite a pool override that a paid rental is running on.
 *
 * Per rental, `worker_name` is updated only AFTER its PUT succeeds, so a partial failure
 * re-plans and retries on the next tick instead of recording a correction that never
 * reached MRR. Idempotent: once every row matches, planWorkerRepairs returns nothing.
 */
async function repairWorkers(conn, client, { endpoint, runMode, now } = {}) {
  const nowMs = now || Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const plan = planWorkerRepairs(conn, endpoint);
  if (!plan.length) return { ran: false, reason: 'nothing_stale' };
  if (runMode !== 'live') return { ran: false, reason: 'dry_run', stale: plan.length };
  if (!client) return { ran: false, reason: 'no_client', stale: plan.length };

  let repaired = 0;
  let failed = 0;
  for (const p of plan) {
    try {
      await client.put(`/rental/${p.mrr_id}/pool/0`, {
        host: endpoint.host, port: endpoint.port, user: p.to, pass: p.stratum_pass || 'x', priority: 0,
      });
    } catch { failed += 1; continue; }   // no row update -> retried next tick
    conn.prepare('UPDATE rentals SET worker_name = ?, pool_host = ?, pool_port = ? WHERE mrr_id = ?')
      .run(p.to, endpoint.host, endpoint.port, p.mrr_id);
    const moved = p.hostMoved ? `@${p.fromHost}:${p.fromPort}->${endpoint.host}:${endpoint.port}` : '';
    conn.prepare('INSERT INTO decisions (algo, ts, session_id, dry_run, note) VALUES (?, ?, ?, ?, ?)')
      .run(market.activeAlgo(conn), nowSec, p.session_id, 0, `worker_repair:${p.mrr_id}:${p.from || 'none'}->${p.to}${moved}`);
    repaired += 1;
  }
  if (repaired) {
    // One notice per destination (address + endpoint) per session, kept current: a pass that
    // moves stragglers left by an earlier one adds to its count and updates how many are still
    // to move, so the notice reads "nothing left" once they have all gone. A later change to a
    // different address or host raises its own notice.
    const address = endpoints.poolAddress(plan[0].to);
    const key = `${address}@${endpoint.host}:${endpoint.port}#s${plan[0].session_id}`;
    const context = {
      repaired, failed, sample: { mrr_id: plan[0].mrr_id, from: plan[0].from, to: plan[0].to },
      // A new payout address and a corrected name format are different news for the user:
      // one confirms a change they made, the other reports a fault that cost them hashrate.
      address_changed: plan.some((p) => endpoints.poolAddress(p.from || '') !== endpoints.poolAddress(p.to)),
      address,
      host_changed: plan.some((p) => p.hostMoved),
      // A failed override leaves a rental on the shared username, which pools credit to the
      // same address: worth fixing for per-rental attribution, but nothing was being lost.
      from_shared: plan.some((p) => p.from === endpoint.worker_base),
      endpoint: `${endpoint.host}:${endpoint.port}`,
    };
    const prior = conn.prepare("SELECT id, context_json FROM alerts WHERE kind = 'worker_repaired' AND key = ?").get(key);
    if (prior) {
      let was = {};
      try { was = JSON.parse(prior.context_json || '{}') || {}; } catch { /* rewrite it whole */ }
      conn.prepare('UPDATE alerts SET context_json = ? WHERE id = ?').run(JSON.stringify({
        ...context,
        repaired: (was.repaired || 0) + repaired,
        address_changed: !!was.address_changed || context.address_changed,
        host_changed: !!was.host_changed || context.host_changed,
        from_shared: !!was.from_shared || context.from_shared,
        sample: was.sample || context.sample,
      }), prior.id);
    } else {
      alerts.fireOnce(conn, { kind: 'worker_repaired', key, now: nowMs, context });
    }
  }
  return { ran: true, repaired, failed };
}

module.exports = { planWorkerRepairs, repairWorkers };
