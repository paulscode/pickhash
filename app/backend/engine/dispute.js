'use strict';
/*
 * Dispute assistant. Pure.
 *
 * MRR prunes rental history, so at rental end we snapshot the graph + final detail into
 * an evidence bundle. Underperformance refunds are web-only tickets the user files within
 * 12h of the rental END — the countdown is computed from MRR's OWN `end` timestamp, never
 * the local clock, so a skewed box can't misreport the window.
 */
const DISPUTE_WINDOW_SEC = 12 * 3600;
const ESCALATE_SEC = 3 * 3600;
const FILE_NOW_SEC = 15 * 60;
// MRR auto-reviews any rental that averages below this and typically auto-refunds the
// under-delivered difference, so a rental ending below it is dispute-eligible (the user
// only needs to file a Support Ticket if the auto-refund doesn't come through). MRR
// lowered this policy threshold from 95% to 93%.
const DISPUTE_THRESHOLD_PCT = 93;

/** Parse an MRR graph period string ("none" | "[ms,ms],[ms,ms]") into {start,end} pairs. */
function parsePeriods(s) {
  if (!s || s === 'none') return [];
  try {
    return JSON.parse('[' + s + ']').map((p) => ({ start: Number(p[0]), end: Number(p[1]) }));
  } catch { return []; }
}

/** Build the evidence bundle from a rental detail + graph. `capturedAt` is stamped by the caller. */
function buildEvidence(detail, graph, rental, capturedAt = null) {
  const avg = (detail && detail.hashrate && detail.hashrate.average) || {};
  const cd = (graph && graph.chartdata) || {};
  const percent = avg.percent != null && avg.percent !== '' ? Number(avg.percent) : null;
  const endTs = detail && detail.end_unix != null ? Number(detail.end_unix)
    : (rental && rental.end_ts != null ? Number(rental.end_ts) : null);
  return {
    mrr_id: rental.mrr_id,
    rig_id: rental.rig_id,
    rig_name: rental.rig_name,
    advertised_th: rental.advertised_th,
    final_percent: percent,
    delivered_th: percent != null && rental.advertised_th != null ? rental.advertised_th * (percent / 100) : null,
    end_ts: endTs,
    offline_periods: parsePeriods(cd.offline),
    pooloffline_periods: parsePeriods(cd.pooloffline),
    captured_at: capturedAt,
  };
}

/** A rental that ended below the delivery threshold is dispute-eligible. */
function isDisputable(percent) {
  return percent != null && percent < DISPUTE_THRESHOLD_PCT;
}

/** 12h dispute deadline from MRR's end timestamp (seconds). */
function disputeDeadlineTs(mrrEndUnix) {
  return Number(mrrEndUnix) + DISPUTE_WINDOW_SEC;
}

/** Countdown state from the MRR-derived deadline and now (both seconds). */
function disputeState(deadlineTs, now) {
  const remaining = deadlineTs - now;
  return {
    remaining_sec: remaining,
    escalate: remaining <= ESCALATE_SEC,
    file_now: remaining <= FILE_NOW_SEC,
    expired: remaining <= 0,
  };
}

/** A copy-paste evidence block for the user's dispute ticket. Pure. */
function evidenceText(rental, evidence) {
  const pct = rental.avg_percent != null ? Number(rental.avg_percent).toFixed(2) : '?';
  const adv = rental.advertised_th != null ? Number(rental.advertised_th).toFixed(0) : '?';
  const offline = (evidence && evidence.offline_periods && evidence.offline_periods.length) || 0;
  const lines = [
    `Rental #${rental.mrr_id} — rig "${rental.rig_name}"`,
    `Delivered ${pct}% of the advertised ${adv} TH/s over ${rental.length_hours}h.`,
  ];
  if (offline) lines.push(`${offline} offline period(s) recorded during the rental.`);
  lines.push('Requesting a prorated refund for the under-delivered hashrate.');
  return lines.join('\n');
}

/** MRR deep links for the ticket flow. */
function links(mrrId) {
  return {
    rental: `https://www.miningrigrentals.com/rental/${mrrId}`,
    tickets: 'https://www.miningrigrentals.com/account/tickets',
  };
}

module.exports = {
  parsePeriods, buildEvidence, isDisputable, disputeDeadlineTs, disputeState, links, evidenceText,
  DISPUTE_WINDOW_SEC, DISPUTE_THRESHOLD_PCT,
};
