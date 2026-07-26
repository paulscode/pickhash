'use strict';
/*
 * Alert evaluator (state-transition machinery).
 *
 * Two shapes of alert:
 *   - Sustained conditions (underdelivering, offline, endpoint_down, mrr_api_outage,
 *     balance_low): arm on the first bad observation, FIRE after a wall-clock threshold,
 *     RESOLVE (paired recovery) on heal. A blip/held reading must not arm or advance —
 *     the caller passes `bad` only for fresh observations.
 *   - Edge events (deposit_seen/cleared, dispute_window, session_ended, refund_received):
 *     fire once per (kind,key), deduped.
 *
 * State lives entirely in the `alerts` table, so a restart mid-alert re-derives from the
 * DB and never re-fires an already-fired/acked alert (hydration is just reading the row).
 *
 * `endpoint_down`, once fired, sets the new-rents gate flag (queried by the gate); it
 * never touches existing rentals — we can't cancel paid MRR time, and shouldn't.
 */

const DEFAULTS = {
  endpoint_down_ms: 150 * 1000,     // ~3 consecutive 60s probes
  mrr_api_outage_ms: 10 * 60 * 1000,
  balance_low_ms: 2 * 60 * 1000,
  balance_low_runway_hours: 2,
  deposit_min_delta_sats: 1000,     // ignore dust wiggle; a real deposit is meaningful
};

const SEVERITY = {
  rental_underdelivering: 'warning',
  rental_offline: 'warning',
  endpoint_down: 'critical',
  mrr_api_outage: 'critical',
  balance_low: 'warning',
  deposit_seen: 'info',
  deposit_cleared: 'info',
  dispute_window: 'warning',
  session_ended: 'info',
  refund_received: 'info',
  needs_reconcile: 'warning',
  endpoint_repaired: 'warning',
  rental_extended: 'info',
  rental_adopted: 'warning',
  rate_ceiling_hold: 'warning',
};

function currentActive(conn, kind, key) {
  return conn.prepare("SELECT * FROM alerts WHERE kind = ? AND key IS ? AND state IN ('armed','fired') ORDER BY id DESC LIMIT 1")
    .get(kind, key);
}

/** Sustained arm/fire/resolve transition. Returns a fired/resolved event or null. */
function runTransition(conn, { kind, key = null, bad, now, thresholdMs = 0, context = {} }) {
  const cur = currentActive(conn, kind, key);
  if (bad) {
    if (!cur) {
      const info = conn.prepare('INSERT INTO alerts (kind, key, severity, state, armed_at, context_json) VALUES (?,?,?,?,?,?)')
        .run(kind, key, SEVERITY[kind] || 'warning', 'armed', now, JSON.stringify(context));
      if (thresholdMs <= 0) {
        conn.prepare("UPDATE alerts SET state='fired', fired_at=? WHERE id=?").run(now, info.lastInsertRowid);
        return { event: 'fired', kind, key, id: Number(info.lastInsertRowid), context };
      }
      return null;
    }
    if (cur.state === 'armed' && now - cur.armed_at >= thresholdMs) {
      conn.prepare("UPDATE alerts SET state='fired', fired_at=?, context_json=? WHERE id=?").run(now, JSON.stringify(context), cur.id);
      return { event: 'fired', kind, key, id: cur.id, context };
    }
    return null;
  }
  // heal
  if (cur) {
    conn.prepare("UPDATE alerts SET state='resolved', resolved_at=? WHERE id=?").run(now, cur.id);
    if (cur.state === 'fired') return { event: 'resolved', kind, key, id: cur.id };
  }
  return null;
}

/**
 * Raise a needs_reconcile halt, deduped on the ACTIVE (armed/fired) state only — NOT on a prior
 * resolved/acked row. Unlike fireOnce (which dedups across all states, correct for a true one-shot
 * like session_ended), a reconcile halt for a given key can legitimately recur: once its orphan is
 * adopted (resolveReconcile) or the user acks it, a LATER ambiguous event on the same key must be
 * able to re-halt — otherwise fireOnce would silently suppress it and autonomous spend would
 * proceed unguarded. Returns the fired event or null if a halt is already active for this key.
 */
function raiseReconcile(conn, { key = null, now = Date.now(), context = {} }) {
  const active = conn.prepare("SELECT id FROM alerts WHERE kind = 'needs_reconcile' AND key IS ? AND state IN ('armed','fired')").get(key);
  if (active) return null;
  const info = conn.prepare("INSERT INTO alerts (kind, key, severity, state, armed_at, fired_at, context_json) VALUES ('needs_reconcile',?,?,'fired',?,?,?)")
    .run(key, SEVERITY.needs_reconcile || 'warning', now, now, JSON.stringify(context));
  return { event: 'fired', kind: 'needs_reconcile', key, id: Number(info.lastInsertRowid), context };
}

/** Fire a one-shot event once per (kind,key). Returns the event or null if already seen. */
function fireOnce(conn, { kind, key = null, now, context = {} }) {
  const existing = conn.prepare('SELECT id FROM alerts WHERE kind = ? AND key IS ?').get(kind, key);
  if (existing) return null;
  const info = conn.prepare('INSERT INTO alerts (kind, key, severity, state, armed_at, fired_at, context_json) VALUES (?,?,?,?,?,?,?)')
    .run(kind, key, SEVERITY[kind] || 'info', 'fired', now, now, JSON.stringify(context));
  return { event: 'fired', kind, key, id: Number(info.lastInsertRowid), context };
}

/** Sats/hour burn across active rentals (fee-inclusive, prorated over each length). */
function burnRateSatsPerHour(rentals) {
  return (rentals || []).filter((r) => !r.ended).reduce((s, r) => {
    const cost = (r.paid_sats || 0) + (r.fee_sats || 0);
    return s + (r.length_hours > 0 ? cost / r.length_hours : 0);
  }, 0);
}

/**
 * Per-tick evaluation from an observe() snapshot. Emits fired/resolved events and writes
 * transitions. `prev` carries the last balance for deposit edge detection.
 */
function evaluate(conn, snapshot, prev = {}, now = Date.now(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const events = [];
  const push = (e) => { if (e) events.push(e); };
  const s = snapshot || { rentals: [], fetch_ok: {} };

  // Per-rental health -> underdelivering / offline (health already applied the 10-min
  // debounce, so the alert threshold here is 0 to avoid double-debouncing).
  for (const r of s.rentals || []) {
    if (r.ended) {
      // clear any active rental alerts for an ended rental
      push(runTransition(conn, { kind: 'rental_underdelivering', key: String(r.mrr_id), bad: false, now }));
      push(runTransition(conn, { kind: 'rental_offline', key: String(r.mrr_id), bad: false, now }));
      continue;
    }
    const ctx = { rig: r.rig_id, name: r.rig_name, percent: r.percent };
    push(runTransition(conn, { kind: 'rental_underdelivering', key: String(r.mrr_id), bad: r.health === 'degraded', now, context: ctx }));
    push(runTransition(conn, { kind: 'rental_offline', key: String(r.mrr_id), bad: r.health === 'offline', now, context: ctx }));
  }

  // endpoint_down — only when we have a fresh probe (fetch_ok.endpoint) that is down.
  if (s.endpoint) {
    const bad = s.fetch_ok.endpoint !== false && !s.endpoint.ok;
    push(runTransition(conn, { kind: 'endpoint_down', bad, now, thresholdMs: c.endpoint_down_ms, context: { host: s.endpoint.host, port: s.endpoint.port } }));
  }

  // mrr_api_outage — the rentals list failing.
  push(runTransition(conn, { kind: 'mrr_api_outage', bad: s.fetch_ok.rentals === false, now, thresholdMs: c.mrr_api_outage_ms }));

  // balance_low — runway under the lead time (only meaningful while burning).
  if (s.balance && s.fetch_ok.balance !== false) {
    const burn = burnRateSatsPerHour(s.rentals);
    const runwayH = burn > 0 ? s.balance.confirmed_sats / burn : Infinity;
    const bad = burn > 0 && runwayH < c.balance_low_runway_hours;
    push(runTransition(conn, { kind: 'balance_low', bad, now, thresholdMs: c.balance_low_ms, context: { runway_hours: Number.isFinite(runwayH) ? Math.round(runwayH * 10) / 10 : null } }));
  }

  // deposit edge events — a meaningful increase, not dust wiggle.
  if (s.balance && prev.balance) {
    const d = c.deposit_min_delta_sats;
    if ((s.balance.unconfirmed_sats || 0) - (prev.balance.unconfirmed_sats || 0) >= d) {
      push(fireOnce(conn, { kind: 'deposit_seen', key: String(now), now, context: { unconfirmed_sats: s.balance.unconfirmed_sats } }));
    }
    if ((s.balance.confirmed_sats || 0) - (prev.balance.confirmed_sats || 0) >= d) {
      push(fireOnce(conn, { kind: 'deposit_cleared', key: String(now), now, context: { confirmed_sats: s.balance.confirmed_sats } }));
    }
  }

  return events;
}

/** New rents are halted while an endpoint_down alert is fired (gate flag). */
function newRentsHalted(conn) {
  return !!conn.prepare("SELECT 1 FROM alerts WHERE kind = 'endpoint_down' AND state = 'fired'").get();
}

/** Autonomous spend is paused while a needs_reconcile alert is fired (an untracked orphan). */
function reconcileHalted(conn) {
  return !!conn.prepare("SELECT 1 FROM alerts WHERE kind = 'needs_reconcile' AND state = 'fired'").get();
}

/**
 * Clear a needs_reconcile halt once its orphan has actually been reconciled (auto-adopted). This
 * is what makes auto-adoption UNATTENDED: without it the halt fired at the ambiguous create stays
 * up forever and autopilot never resumes. Resolves only the specific (kind,key); genuinely-
 * unattributable strays keep their own halt for manual review. Returns whether a row cleared.
 */
function resolveReconcile(conn, key, now = Date.now()) {
  const info = conn.prepare("UPDATE alerts SET state='resolved', resolved_at=? WHERE kind='needs_reconcile' AND key IS ? AND state IN ('armed','fired')").run(now, key);
  return info.changes > 0;
}

/**
 * Backstop resolve for per-rental health alerts: normally `evaluate` resolves a fired
 * rental_offline/rental_underdelivering when the ended rental appears in the snapshot on its
 * transition tick. But if the process dies between observe committing `ended=1` and the alert
 * evaluate, that rental is `ended=1` on restart and excluded from the snapshot forever, so the
 * alert would never auto-resolve. Sweep any such orphan each tick (idempotent). Returns events.
 */
function resolveEndedRentalAlerts(conn, now = Date.now()) {
  const ended = new Set(conn.prepare('SELECT mrr_id FROM rentals WHERE ended = 1').all().map((r) => String(r.mrr_id)));
  const fired = conn.prepare("SELECT kind, key FROM alerts WHERE state = 'fired' AND kind IN ('rental_offline','rental_underdelivering')").all();
  const events = [];
  for (const a of fired) {
    if (ended.has(a.key)) {
      const ev = runTransition(conn, { kind: a.kind, key: a.key, bad: false, now });
      if (ev) events.push(ev);
    }
  }
  return events;
}

function listActive(conn) {
  return conn.prepare("SELECT id, kind, key, severity, state, armed_at, fired_at, context_json FROM alerts WHERE state = 'fired' ORDER BY id DESC").all()
    .map((a) => ({ ...a, context: a.context_json ? JSON.parse(a.context_json) : {} }));
}

function ack(conn, id, now = Date.now()) {
  const info = conn.prepare("UPDATE alerts SET state='acked', acked_at=? WHERE id=? AND state IN ('fired','armed')").run(now, id);
  return info.changes > 0;
}

module.exports = { evaluate, runTransition, fireOnce, raiseReconcile, newRentsHalted, reconcileHalted, resolveReconcile, resolveEndedRentalAlerts, listActive, ack, burnRateSatsPerHour, currentActive, DEFAULTS, SEVERITY };
