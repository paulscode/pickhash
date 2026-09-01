'use strict';
/*
 * The saved stratum endpoint, scoped to the algorithm it belongs to.
 *
 * A BLAKE2b rental has to point at a BLAKE2b stratum. `pool_endpoints` gained an
 * `algo` column in 009, but every read still asked for "the active endpoint" without
 * saying whose, so switching algorithms would have left the previous one's endpoint
 * live: rented hashrate of the right kind, aimed at a pool that cannot use it. That
 * is the same shape as the bug in Datum Gateway (BLAKE2b) where an address was
 * validated against a chain the node was not on. It looks correct locally and only
 * fails somewhere nobody is looking.
 *
 * Each algorithm has at most one active endpoint, and reads are scoped rather than
 * the switch mutating rows. Nothing has to be deactivated on a switch, nothing can
 * get out of step, and switching back finds the endpoint that was there before.
 */
const config = require('./config');

/**
 * The active endpoint for an algorithm, or null.
 *
 * Newest first. Callers used to be split between a bare `.get()` and `ORDER BY id
 * DESC LIMIT 1`, which differ only if more than one row is somehow active — and in
 * that case the newest is the one the user last saved, so it is the better answer
 * for all of them.
 */
function active(conn, algo) {
  const slug = algo || config.activeAlgo(conn);
  return conn.prepare(
    'SELECT * FROM pool_endpoints WHERE active = 1 AND algo = ? ORDER BY id DESC LIMIT 1',
  ).get(slug) || null;
}

/**
 * Stand every endpoint for one algorithm down.
 *
 * Scoped, so saving an endpoint for one algorithm cannot deactivate the other's.
 * Unscoped, a user who set up BLAKE2b would come back to sha256ab and find their
 * endpoint quietly inactive.
 */
function deactivateAll(conn, algo) {
  const slug = algo || config.activeAlgo(conn);
  return conn.prepare('UPDATE pool_endpoints SET active = 0 WHERE algo = ?').run(slug);
}

module.exports = { active, deactivateAll };
