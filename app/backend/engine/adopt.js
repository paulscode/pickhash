'use strict';
/*
 * Auto-adopt an ambiguous-create orphan. An active MRR rental we hold no row
 * for, that MATCHES a pending intent (our create that timed out on the wire but actually
 * succeeded), is recovered here: we insert a tracked rentals row from MRR's authoritative rental
 * detail so decide() counts it (no double-rent for capacity already running), count its real
 * billed cost against the session budget + spend ledger, and (re)apply our per-rental pool
 * override so it delivers to our endpoint. A stray we can't fully adopt (detail unavailable or
 * incomplete) falls back to a needs_reconcile alert rather than being silently dropped. Only the
 * 'adopt' set (matched to our own intent) is adopted; genuinely-unknown 'unattributable' rentals
 * stay a manual-review alert.
 */
const units = require('../units');
const market = require('../market');
const alerts = require('../alerts');

function num(v) { return v === '' || v == null ? null : Number(v); }
function advertisedTh(d) {
  const a = (d.hashrate && d.hashrate.advertised) || {};
  try { return a.hash != null ? units.toTh(a.hash, a.type) : null; } catch { return null; }
}

/**
 * @returns {{adopted:number[], failed:Array}} adopted mrr_ids, and strays that must be alerted instead.
 */
async function adoptStrays(conn, client, { sessionId, endpoint, adopt, nowSec, dryRun }) {
  const result = { adopted: [], failed: [] };
  if (!client || !endpoint || !sessionId || !adopt) return result;
  for (const s of adopt) {
    const mrrId = Number(s.mrrId);
    if (conn.prepare('SELECT 1 FROM rentals WHERE mrr_id = ?').get(mrrId)) continue;   // already tracked
    let d;
    try { d = await client.get(`/rental/${mrrId}`); } catch { result.failed.push(s); continue; }
    const paidTotal = d && d.price && d.price.paid != null ? Math.round(Number(d.price.paid) * 1e8) : 0;
    if (!d || !d.id || !(paidTotal > 0)) { result.failed.push(s); continue; }   // incomplete -> alert, don't guess money
    const base = Math.round(paidTotal / 1.03);   // total is fee-inclusive; split for display only
    const fee = paidTotal - base;
    const lengthHours = num(d.length) || 0;
    const start = num(d.start) > 0 ? num(d.start) : nowSec;
    const end = num(d.end) > 0 ? num(d.end) : start + Math.round(lengthHours * 3600);
    const worker = `${endpoint.worker_base}-r${mrrId}`;
    const adv = advertisedTh(d);
    // Back out the per-TH·day rate (fee-exclusive) so an adopted rig contributes to the hash-value
    // pay-rate like any normal rental: base_btc = rate × adv × (lengthHours/24).
    const rate = adv > 0 && lengthHours > 0 ? (base / 1e8) / (adv * (lengthHours / 24)) : null;
    conn.prepare(
      `INSERT INTO rentals (algo, session_id, mrr_id, rig_id, rig_name, region, advertised_th, length_hours,
                            paid_sats, fee_sats, rate_btc_th_day, start_ts, end_ts, health, worker_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(market.activeAlgo(conn), sessionId, mrrId, s.rigId, (d.rig && d.rig.name) || null, (d.rig && d.rig.region) || null, adv, lengthHours, base, fee, rate, start, end, worker);
    conn.prepare('UPDATE sessions SET spent_sats = COALESCE(spent_sats, 0) + ?, fee_sats = COALESCE(fee_sats, 0) + ? WHERE id = ?')
      .run(paidTotal, fee, sessionId);
    conn.prepare('INSERT INTO spend_events (algo, ts, sats, kind, session_id, mrr_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(market.activeAlgo(conn), nowSec, paidTotal, 'rent', sessionId, mrrId);
    // Point the recovered rental at our endpoint/worker (the ambiguous create's override step
    // may never have run); if this fails, health will flag under-delivery. This is a real MRR
    // mutation, so it runs only in LIVE — recording the already-billed money above is correct in
    // any mode, but a DRY-RUN/paused session must not silently re-point a rental.
    // 'x' rather than a difficulty request. Unlike a normal rental, this path has no
    // quote behind it and so no chosen difficulty: it rebuilds the row from the rental
    // detail, and nothing here reads a rig's optimal_diff. Whether that detail embeds
    // one is untested — the recorded fixture omits the rig object rather than showing
    // it absent — and the rig id is in hand either way (GET /rig/{id} is public and
    // returns optimal_diff), so this is a gap that can be closed, not a dead end.
    //
    // Until then the rental runs at the endpoint's default difficulty, which is what
    // every rental did before per-rig difficulty existed. stratum_pass stays NULL and
    // the repoint paths read that as 'x', so the three stay consistent.
    if (!dryRun) {
      try { await client.put(`/rental/${mrrId}/pool/0`, { host: endpoint.host, port: endpoint.port, user: worker, pass: 'x', priority: 0 }); } catch { /* health flags it */ }
    }
    alerts.fireOnce(conn, { kind: 'rental_adopted', key: `mrr${mrrId}`, now: nowSec * 1000, context: { mrr_id: mrrId, rig: s.rigId, sats: paidTotal } });
    // The orphan is now fully reconciled (tracked, billed, re-pointed) — lift the halt its
    // ambiguous create raised, so autopilot resumes unattended. Both key shapes can carry it:
    // `sess{id}rig{rigId}` (execute's ambiguous top-up) and `mrr{id}` (a prior failed-adopt tick).
    alerts.resolveReconcile(conn, `sess${sessionId}rig${s.rigId}`, nowSec * 1000);
    alerts.resolveReconcile(conn, `mrr${mrrId}`, nowSec * 1000);
    result.adopted.push(mrrId);
  }
  return result;
}

module.exports = { adoptStrays };
