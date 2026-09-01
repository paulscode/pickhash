'use strict';
/*
 * Idempotent MRR account plumbing: ensure a saved pool + a profile for the active
 * algorithm exist for the active endpoint, with the pool at priority 0 (and, when
 * configured, a fallback pool at priority 1). Safe to run repeatedly — a second run
 * finds everything already in place and makes no mutations. Every write is recorded
 * in the decisions audit log.
 *
 * The algorithm comes from market.ALGO rather than being spelled out here. A saved
 * pool and a profile are per-algorithm objects in the MRR account, so provisioning
 * them for one algorithm while the marketplace is being read for another leaves the
 * two silently disagreeing.
 */
const market = require('./market');

function nowSec() { return Math.floor(Date.now() / 1000); }
function asArray(v) { return Array.isArray(v) ? v : []; }

function decision(conn, note, executed) {
  conn.prepare('INSERT INTO decisions (algo, ts, dry_run, note, executed_json) VALUES (?, ?, 0, ?, ?)')
    .run(market.activeAlgo(conn), nowSec(), note, JSON.stringify(executed ?? null));
}

function endpointPoolName(ep) { return `pickhash:${ep.host}:${ep.port}`; }

/**
 * Ensure the saved pool + profile exist for `ep` (a pool_endpoints row), pool at
 * priority 0. Records ids back on the endpoint. Returns { poolId, profileId, mutated }.
 */
async function ensure(conn, client, ep) {
  const name = endpointPoolName(ep);
  let mutated = false;

  // Saved pool (find by name, else create).
  const pools = asArray(await client.get('/account/pool'));
  let pool = pools.find((p) => p.name === name);
  let poolId;
  if (pool) {
    poolId = pool.id;
  } else {
    const created = await client.put('/account/pool', {
      type: market.ALGO, name, host: ep.host, port: ep.port, user: ep.worker_base, pass: 'x',
    });
    poolId = created.id;
    mutated = true;
    decision(conn, `create saved pool ${name}`, created);
  }

  // Profile (find by name, else create).
  const profiles = asArray(await client.get('/account/profile', { algo: market.ALGO }));
  let profile = profiles.find((p) => p.name === name);
  let profileId;
  let poolAtZero = false;
  if (profile) {
    profileId = profile.id || profile.pid;
    poolAtZero = asArray(profile.pools).some(
      (x) => String(x.priority) === '0' && String(x.poolid ?? x.id) === String(poolId),
    );
  } else {
    const created = await client.put('/account/profile', { name, algo: market.ALGO });
    profileId = created.id || created.pid;
    mutated = true;
    decision(conn, `create profile ${name}`, created);
  }

  // Attach the pool at priority 0 only if it isn't already there.
  if (!poolAtZero) {
    const attach = await client.put(`/account/profile/${profileId}/0`, { poolid: poolId });
    mutated = true;
    decision(conn, `attach pool ${poolId} to profile ${profileId} at priority 0`, attach);
  }

  conn.prepare('UPDATE pool_endpoints SET mrr_pool_id = ?, mrr_profile_id = ? WHERE id = ?')
    .run(poolId, profileId, ep.id);

  return { poolId, profileId, mutated };
}

module.exports = { ensure, endpointPoolName };
