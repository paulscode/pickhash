'use strict';
/*
 * Seed a realistic demo session for visual verification of the dashboard/charts.
 * Fabricates a ~week-long, ~3 PH/s, ~1M-sat session at the common operating
 * scale: a ramp, steady delivery near target, a mid-session dip + recovery (a rig going
 * offline), cumulative spend approaching the budget ceiling, and a wiggling market.
 *
 *   DATA_DIR=./data node scripts/seed-demo.js      (idempotent: clears prior demo data)
 *
 * Demo rows are tagged with a sentinel session so a re-run replaces them cleanly.
 */
const path = require('path');
const db = require('../app/backend/db');

const DAY = 86400;
const HOUR = 3600;
const TARGET_TH = 3000;          // ~3 PH/s
const BUDGET_SATS = 1_000_000;
const SPAN = 7 * DAY;            // one week
const STEP = 20 * 60;           // a tick every 20 min

// Deterministic pseudo-random so the demo looks the same each run.
let _s = 987654321;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function noise(a) { return (rnd() - 0.5) * 2 * a; }

function run() {
  db.open(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  const conn = db.get();
  const nowSec = Math.floor(Date.now() / 1000);
  const startTs = nowSec - SPAN;

  // --- Reset any prior demo data ---
  const old = conn.prepare("SELECT id FROM sessions WHERE summary_json = 'DEMO'").all().map((r) => r.id);
  for (const id of old) {
    conn.prepare('DELETE FROM rental_samples WHERE rental_id IN (SELECT mrr_id FROM rentals WHERE session_id = ?)').run(id);
    conn.prepare('DELETE FROM rentals WHERE session_id = ?').run(id);
    conn.prepare('DELETE FROM tick_metrics WHERE session_id = ?').run(id);
    conn.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  conn.prepare("DELETE FROM market_snapshots WHERE ts >= ?").run(startTs);
  conn.prepare("DELETE FROM alerts WHERE context_json LIKE '%\"demo\":true%'").run();

  // --- Session ---
  const info = conn.prepare(
    `INSERT INTO sessions (mode, state, target_th, budget_sats, duration_hours, spent_sats, fee_sats, created_at, started_at, summary_json)
       VALUES ('quick','active',?,?,?,?,?,?,?,'DEMO')`,
  ).run(TARGET_TH, BUDGET_SATS, SPAN / HOUR, 0, 0, startTs, startTs);
  const sessionId = Number(info.lastInsertRowid);

  // --- Rentals (~18 rigs of 120-250 TH summing ~3 PH) ---
  const regions = ['us-east', 'us-west', 'eu', 'eu-de', 'ap', 'sa-br'];
  const rentals = [];
  let sumTh = 0;
  let mid = 7_000_000;
  while (sumTh < TARGET_TH) {
    const adv = 120 + Math.floor(rnd() * 130);
    const th = Math.min(adv, TARGET_TH - sumTh + 40);
    const hours = SPAN / HOUR;
    const paid = Math.round(0.00000002 * th * hours * 1e8);   // ~sats
    const fee = Math.round(paid * 0.03);
    const mrrId = mid++;
    rentals.push({ mrrId, th, paid, fee });
    conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, region, advertised_th, length_hours,
                  paid_sats, fee_sats, rate_btc_th_day, start_ts, end_ts, health, avg_percent, worker_name)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sessionId, mrrId, 300000 + rentals.length, `Miner Rig #${rentals.length + 1}`,
        regions[rentals.length % regions.length], th, hours, paid, fee, 0.00000048,
        startTs, nowSec + 2 * DAY, 'healthy', 96 + noise(2), `bc1qdemo.w-r${mrrId}`);
    sumTh += th;
  }

  // --- tick_metrics: ramp, steady-near-target, a dip+recovery, growing spend ---
  const insTick = conn.prepare(`INSERT OR REPLACE INTO tick_metrics
    (ts, session_id, delivered_th, target_th, active_rentals, spent_sats, balance_confirmed_sats,
     balance_unconfirmed_sats, market_lowest, market_last10, endpoint_ok, mrr_ok, hashgg_ok)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insSample = conn.prepare('INSERT OR REPLACE INTO rental_samples (rental_id, ts, delivered_th, percent, health) VALUES (?,?,?,?,?)');
  const startBalance = 1_050_000;

  for (let ts = startTs; ts <= nowSec; ts += STEP) {
    const f = (ts - startTs) / SPAN;                 // 0..1 through the week
    // ramp over the first ~3h, then steady near target with a dip around f=0.4-0.5.
    const ramp = Math.min(1, (ts - startTs) / (3 * HOUR));
    let frac = 0.985 + noise(0.01);
    if (f > 0.40 && f < 0.52) frac = 0.80 + noise(0.03);   // a rig offline / degraded window
    const delivered = Math.max(0, TARGET_TH * ramp * frac);
    const spent = Math.round(BUDGET_SATS * f * (0.95 + noise(0.02)));
    const lowest = 0.00000050 + noise(0.00000004);   // per-TH·day
    const last10 = 0.00000065 + noise(0.00000005);
    insTick.run(ts, sessionId, delivered, TARGET_TH, rentals.length, spent,
      Math.max(0, startBalance - spent), 0, lowest, last10, 1, 1, 1);
    if (ts % (2 * HOUR) < STEP) {
      conn.prepare('INSERT OR REPLACE INTO market_snapshots (ts, lowest, last10, last, available_rigs, available_th, depth_json) VALUES (?,?,?,?,?,?,?)')
        .run(ts, lowest, last10, last10, 1400, 36000000, '[]');
    }
    // Per-rental samples (every 2h) so the stacked per-rig chart has data.
    if (ts % (2 * HOUR) < STEP) {
      for (const r of rentals) {
        const rfrac = Math.max(0, frac + noise(0.02));
        insSample.run(r.mrrId, ts, r.th * rfrac, rfrac * 100, rfrac < 0.9 ? 'degraded' : 'healthy');
      }
    }
  }

  // --- A live alert (one rig underdelivering) so the strip renders ---
  const bad = rentals[3];
  conn.prepare('UPDATE rentals SET health = ?, avg_percent = ? WHERE mrr_id = ?').run('degraded', 82, bad.mrrId);
  conn.prepare(`INSERT INTO alerts (kind, key, severity, state, armed_at, fired_at, context_json)
                VALUES ('rental_underdelivering', ?, 'warning', 'fired', ?, ?, ?)`)
    .run(String(bad.mrrId), nowSec - 600, nowSec - 300, JSON.stringify({ demo: true, rig: 300003, name: 'Miner Rig #4', percent: 82 }));

  // Reflect the final spend on the session row (the hero tile reads this).
  const finalSpent = Math.round(BUDGET_SATS * 0.93);
  const totalFee = rentals.reduce((s, r) => s + r.fee, 0);
  conn.prepare('UPDATE sessions SET spent_sats = ?, fee_sats = ? WHERE id = ?').run(finalSpent, totalFee, sessionId);

  const th = rentals.reduce((s, r) => s + r.th, 0);
  console.log(`Seeded demo session #${sessionId}: ${rentals.length} rigs, ${(th / 1000).toFixed(2)} PH/s target, ~${Math.round((nowSec - startTs) / DAY)}d span.`);
  console.log(`tick_metrics rows: ${conn.prepare('SELECT COUNT(*) n FROM tick_metrics WHERE session_id=?').get(sessionId).n}`);
  db.close();
}

run();
