'use strict';
// Seed a demo session into a throwaway DB and emit the /api/metrics + /api/status
// payloads to tmp/payloads.json, for the visual screenshot harness. Run in docker.
const fs = require('fs');
process.env.DATA_DIR = '/app/tmp/demodb';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
require('./seed-demo');   // seeds, then closes the db

const db = require('../app/backend/db');
const charts = require('../app/backend/charts');
const alerts = require('../app/backend/alerts');
db.open(process.env.DATA_DIR);
const conn = db.get();
const latest = conn.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').get();
const ticks = conn.prepare('SELECT ts, delivered_th, target_th, spent_sats FROM tick_metrics WHERE session_id = ? ORDER BY ts').all(latest.id);
const snaps = conn.prepare('SELECT ts, lowest, last10 FROM market_snapshots ORDER BY ts').all();
const rentals = conn.prepare('SELECT mrr_id, rig_id, rig_name, region, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, health FROM rentals WHERE session_id = ? ORDER BY id').all(latest.id);

const samples = conn.prepare(
  `SELECT rs.rental_id, rs.ts, rs.delivered_th, r.rig_name
     FROM rental_samples rs JOIN rentals r ON r.mrr_id = rs.rental_id
    WHERE r.session_id = ? ORDER BY rs.ts`,
).all(latest.id);
const metrics = {
  range: 'all',
  delivered: charts.buildDelivered(ticks, { targetTh: latest.target_th }),
  delivered_stacked: charts.buildDeliveredStacked(samples, ticks, { targetTh: latest.target_th }),
  spend: charts.buildSpend(ticks, { budgetSats: latest.budget_sats }),
  market: charts.buildMarket(snaps),
};
const status = {
  ok: true, mode: 'dry-run',
  session: { id: latest.id, state: 'active', target_th: latest.target_th, budget_sats: latest.budget_sats, duration_hours: latest.duration_hours, spent_sats: latest.spent_sats, fee_sats: latest.fee_sats, started_at: latest.started_at },
  rentals, alerts: alerts.listActive(conn),
};
fs.writeFileSync('/app/tmp/payloads.json', JSON.stringify({ metrics, status }));
console.log('wrote tmp/payloads.json');
