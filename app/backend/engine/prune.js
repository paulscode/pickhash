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

function prune(conn, nowSec, retainDays = RETAIN_DAYS) {
  const cutoff = nowSec - retainDays * DAY;
  conn.prepare('DELETE FROM tick_metrics WHERE ts < ?').run(cutoff);
  conn.prepare('DELETE FROM rental_samples WHERE ts < ?').run(cutoff);
  conn.prepare('DELETE FROM market_snapshots WHERE ts < ?').run(cutoff);
}

module.exports = { prune, RETAIN_DAYS };
