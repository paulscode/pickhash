'use strict';
/*
 * Rig scoring. Each rig's realized delivery is folded into a persistent per-rig score when
 * a rental of it ENDS; the running mean becomes `expectedDelivery` in the rank key (quote.js), so a
 * rig that has historically under-delivered ranks below a slightly-pricier reliable one — and a
 * rig that delivered nothing is heavily penalized. Pure fold + impure persist/load. (The manual
 * blacklist is separate — it lives in strategy.blacklist_rig_ids and is applied by the candidates
 * filter.)
 */

const OFFLINE_PCT = 10;   // a rental whose final delivered% is below this counts as an offline incident

/**
 * Pure: fold one finished rental's delivery into a rig's running score.
 * A null/undefined final percent (never delivered a reading) scores as 0 — the worst case.
 */
function foldScore(prev, { percent, price, nowSec }) {
  const p = prev || { rentals: 0, mean_percent: null, offline_incidents: 0, last_price: null };
  const n = (p.rentals || 0) + 1;
  const pct = percent == null ? 0 : Number(percent);
  const prevMean = p.mean_percent == null ? pct : p.mean_percent;
  const mean = (prevMean * (n - 1) + pct) / n;           // incremental running mean
  return {
    rentals: n,
    mean_percent: mean,
    offline_incidents: (p.offline_incidents || 0) + (pct < OFFLINE_PCT ? 1 : 0),
    last_price: price != null ? Number(price) : (p.last_price != null ? p.last_price : null),
    last_seen: nowSec,
  };
}

/** Impure: record a finished rental's outcome into rig_scores (UPSERT). Best-effort. */
function recordRentalScore(conn, rental, finalPercent, nowSec) {
  if (!rental || rental.rig_id == null) return null;
  const prev = conn.prepare('SELECT rentals, mean_percent, offline_incidents, last_price FROM rig_scores WHERE rig_id = ?').get(rental.rig_id) || null;
  const next = foldScore(prev, { percent: finalPercent, price: rental.rate_btc_th_day != null ? rental.rate_btc_th_day : null, nowSec });
  conn.prepare(
    `INSERT INTO rig_scores (rig_id, rentals, mean_percent, offline_incidents, last_price, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rig_id) DO UPDATE SET rentals = excluded.rentals, mean_percent = excluded.mean_percent,
         offline_incidents = excluded.offline_incidents, last_price = excluded.last_price, last_seen = excluded.last_seen`,
  ).run(rental.rig_id, next.rentals, next.mean_percent, next.offline_incidents, next.last_price, next.last_seen);
  return next;
}

/**
 * Impure: load rig_scores into the { rigId: expectedDelivery(0..1) } map decide/quote consume.
 * mean_percent is a % (0..100+); clamp to [0,1] as a delivery fraction. Rigs with no score are
 * absent -> quote defaults them to 1.0 (unproven rigs aren't penalized until they under-deliver).
 */
function loadRigScores(conn) {
  const out = {};
  for (const r of conn.prepare('SELECT rig_id, mean_percent FROM rig_scores').all()) {
    if (r.mean_percent != null) out[String(r.rig_id)] = Math.max(0, Math.min(1, r.mean_percent / 100));
  }
  return out;
}

module.exports = { foldScore, recordRentalScore, loadRigScores, OFFLINE_PCT };
