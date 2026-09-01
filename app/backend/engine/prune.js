'use strict';
/*
 * Retention pruning. The raw per-tick tables grow forever otherwise. We keep a
 * bounded window of raw rows and keep the money/audit records (sessions, rentals, decisions,
 * rig_scores, alerts, applied_refunds) forever. Runs on a daily piggyback cadence from
 * observe. (Hourly rollups of pruned raw data are a future enhancement; a bounded raw
 * window is enough to keep the DB from growing unbounded.)
 */
const DAY = 86400;
const RETAIN_DAYS = 90;

/*
 * Deliberately NOT scoped by algorithm, unlike every other read and write of these
 * tables. Retention exists to bound the database, and old raw rows should age out
 * whichever algorithm produced them. Scoping this would leave the inactive
 * algorithm's ticks and samples growing without limit, since prune only ever runs
 * on the active one's cadence. This is the one place where crossing algorithms is
 * correct, which is why it says so.
 */
function prune(conn, nowSec, retainDays = RETAIN_DAYS) {
  const cutoff = nowSec - retainDays * DAY;
  conn.prepare('DELETE FROM tick_metrics WHERE ts < ?').run(cutoff);
  conn.prepare('DELETE FROM rental_samples WHERE ts < ?').run(cutoff);
  conn.prepare('DELETE FROM market_snapshots WHERE ts < ?').run(cutoff);
}

module.exports = { prune, RETAIN_DAYS };
