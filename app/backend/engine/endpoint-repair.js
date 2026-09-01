'use strict';
/*
 * Endpoint auto-repair. A HashGG tunnel — especially playit — can come back
 * on a NEW host:port after a restart, which silently kills delivery for every active rental:
 * they keep pointing at the dead endpoint and just stop hashing. When our saved endpoint has
 * stopped delivering AND HashGG reports a different, reachable public endpoint, re-point:
 * update the saved pool endpoint and re-issue each active rental's per-rental pool override to
 * the new host:port, then alert so the operator knows it moved.
 *
 * Re-pointing already-paid rentals is not a spend, but it is an MRR mutation, so the per-rental
 * override calls run only in LIVE; the local saved-endpoint update (used by the health probe and
 * by any new top-up rentals) always happens so the system converges on the correct endpoint.
 */
const alerts = require('../alerts');
const endpointUtil = require('../endpoint');
const market = require('../market');

/**
 * Pure: decide whether to repair, and to what. Returns { from, to } or null.
 * Repairs only when the CURRENT endpoint isn't delivering (endpointOk false) AND HashGG reports
 * a different reachable endpoint — so a still-working endpoint or a transient blip is left alone.
 */
function planRepair({ storedEndpoint, endpointOk, hashgg }) {
  if (!storedEndpoint || !storedEndpoint.host) return null;
  const pub = hashgg && hashgg.reachable ? hashgg.publicEndpoint : null;
  if (!pub || !pub.host || !(pub.port > 0)) return null;
  const changed = String(pub.host) !== String(storedEndpoint.host) || Number(pub.port) !== Number(storedEndpoint.port);
  if (!changed) return null;
  if (endpointOk) return null;   // current endpoint still delivers — don't churn active rentals
  return { from: { host: storedEndpoint.host, port: storedEndpoint.port }, to: { host: pub.host, port: pub.port } };
}

/**
 * Impure: apply a repair plan. Updates the saved endpoint, re-points each active rental's pool
 * override (LIVE only), and fires an endpoint_repaired alert. Idempotent across ticks: once the
 * saved endpoint matches HashGG, planRepair returns null so this runs at most once per change.
 */
async function repair(conn, client, { plan, runMode, now }) {
  if (!plan) return null;
  // Never re-point paid rentals at a blocked (internal / cloud-metadata / unspecified) address, even
  // if the HashGG-reported endpoint claims one — defense-in-depth against a spoofed or MITM'd HashGG
  // response. Skip the repair rather than redirect purchased hashrate somewhere dangerous; the
  // endpoint stays flagged and the operator is alerted through the existing endpoint-health path.
  const pinned = await endpointUtil.resolvePinnedIp(plan.to.host);
  if (!pinned) return { from: plan.from, to: plan.to, rentals: 0, active: 0, failed: 0, blocked: true };
  // rerouted_ocean rentals were deliberately parked on Ocean by dead-rig fallback (dead on our pool);
  // don't yank them back to the endpoint — they'd just go offline again and flap.
  const active = conn.prepare(
    "SELECT r.mrr_id, r.worker_name FROM rentals r JOIN sessions s ON s.id = r.session_id WHERE s.state IN ('active', 'winding_down') AND r.ended = 0 AND r.rerouted_ocean = 0",
  ).all();
  let repaired = 0;
  let failed = 0;
  if (runMode === 'live' && client) {
    for (const r of active) {
      try {
        await client.put(`/rental/${r.mrr_id}/pool/0`, { host: plan.to.host, port: plan.to.port, user: r.worker_name, pass: 'x', priority: 0 });
        repaired += 1;
      } catch { failed += 1; }
    }
  }
  // Converge the saved endpoint ONLY once every active rental is re-pointed (or there are none,
  // or DRY-RUN has nothing to mutate). If a PUT failed, leave the saved endpoint on the old value
  // so planRepair re-triggers next tick and retries the straggler — otherwise idempotency
  // short-circuits and that rental stays stranded on the dead endpoint for its paid duration.
  if (failed === 0) {
    // Scoped like every other endpoint write: a repair belongs to one algorithm's
      // endpoint, not to whichever rows happen to be flagged active.
      conn.prepare('UPDATE pool_endpoints SET host = ?, port = ? WHERE active = 1 AND algo = ?')
        .run(plan.to.host, plan.to.port, market.activeAlgo(conn));
  }
  alerts.fireOnce(conn, {
    kind: 'endpoint_repaired', key: `${plan.to.host}:${plan.to.port}`, now,
    context: { from: plan.from, to: plan.to, rentals: repaired, active: active.length },
  });
  return { from: plan.from, to: plan.to, rentals: repaired, active: active.length, failed };
}

module.exports = { planRepair, repair };
