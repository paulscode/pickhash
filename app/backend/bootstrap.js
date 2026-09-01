'use strict';
/*
 * Idempotent MRR account plumbing: ensure a saved pool + a profile for the active
 * algorithm exist for the active endpoint, with the pool at priority 0 (and, when
 * configured, a fallback pool at priority 1). Safe to run repeatedly — a second run
 * finds everything already in place and makes no mutations. Every write is recorded
 * in the decisions audit log.
 *
 * The algorithm comes from market.activeAlgo rather than being spelled out here. A saved
 * pool and a profile are per-algorithm objects in the MRR account, so provisioning
 * them for one algorithm while the marketplace is being read for another leaves the
 * two silently disagreeing.
 */
const market = require('./market');
const algos = require('./algos');

function nowSec() { return Math.floor(Date.now() / 1000); }
function asArray(v) { return Array.isArray(v) ? v : []; }

function decision(conn, note, executed) {
  conn.prepare('INSERT INTO decisions (algo, ts, dry_run, note, executed_json) VALUES (?, ?, 0, ?, ?)')
    .run(market.activeAlgo(conn), nowSec(), note, JSON.stringify(executed ?? null));
}

/*
 * The name this app gives its saved pool and profile in the MRR account.
 *
 * Qualified by algorithm for everything except sha256ab, which keeps the original
 * unqualified name. Saved pools and profiles are per-algorithm objects but the
 * account-wide GET is not filtered, so two algorithms pointed at the same host:port
 * would produce two objects with one name, and the lookup below would adopt
 * whichever came back first. Leaving sha256ab's name alone means existing accounts
 * keep using the pool and profile they already have rather than stranding them and
 * building a duplicate.
 */
function endpointPoolName(ep, algo) {
  const prefix = algo === algos.DEFAULT_ALGO ? 'pickhash' : `pickhash:${algo}`;
  return `${prefix}:${ep.host}:${ep.port}`;
}

/**
 * Ensure the saved pool + profile exist for `ep` (a pool_endpoints row), pool at
 * priority 0. Records ids back on the endpoint. Returns { poolId, profileId, mutated }.
 */
async function ensure(conn, client, ep) {
  const algo = market.activeAlgo(conn);
  const name = endpointPoolName(ep, algo);
  let mutated = false;

  // Saved pool (find by name, else create). The type check is belt and braces on top
  // of the qualified name: GET /account/pool is not filtered by algorithm, so a pool
  // of the wrong type must never be adopted even if the names somehow agree.
  const pools = asArray(await client.get('/account/pool'));
  let pool = pools.find((p) => p.name === name && (!p.type || p.type === algo));
  let poolId;
  if (pool) {
    poolId = pool.id;
  } else {
    const created = await client.put('/account/pool', {
      type: algo, name, host: ep.host, port: ep.port, user: ep.worker_base, pass: 'x',
    });
    poolId = created.id;
    mutated = true;
    decision(conn, `create saved pool ${name}`, created);
  }

  // Profile (find by name, else create).
  const profiles = asArray(await client.get('/account/profile', { algo }));
  let profile = profiles.find((p) => p.name === name);
  let profileId;
  let poolAtZero = false;
  if (profile) {
    profileId = profile.id || profile.pid;
    poolAtZero = asArray(profile.pools).some(
      (x) => String(x.priority) === '0' && String(x.poolid ?? x.id) === String(poolId),
    );
  } else {
    const created = await client.put('/account/profile', { name, algo });
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
