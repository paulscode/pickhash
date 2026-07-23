'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const alerts = require('../alerts');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-alerts-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => { db.get().prepare('DELETE FROM alerts').run(); });

const snap = (o) => ({ rentals: [], fetch_ok: { rentals: true, balance: true, endpoint: true }, ...o });

test('a degraded rental fires rental_underdelivering, and healing resolves it', () => {
  const conn = db.get();
  const degraded = snap({ rentals: [{ mrr_id: 1, rig_id: 9, health: 'degraded', percent: 82, ended: false }] });
  const e1 = alerts.evaluate(conn, degraded, {}, 1000);
  assert.equal(e1.filter((e) => e.kind === 'rental_underdelivering' && e.event === 'fired').length, 1);
  // Evaluate again while still degraded: no duplicate fire (hydration/idempotent).
  const e2 = alerts.evaluate(conn, degraded, {}, 2000);
  assert.equal(e2.length, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE state='fired'").get().n, 1);
  // Heal -> resolved.
  const healthy = snap({ rentals: [{ mrr_id: 1, rig_id: 9, health: 'healthy', percent: 98, ended: false }] });
  const e3 = alerts.evaluate(conn, healthy, {}, 3000);
  assert.ok(e3.some((e) => e.kind === 'rental_underdelivering' && e.event === 'resolved'));
});

test('resolveEndedRentalAlerts clears an orphaned fired rental alert once its rental has ended', () => {
  const conn = db.get();
  alerts.fireOnce(conn, { kind: 'rental_offline', key: '42', now: 1000 });
  // No matching ended rental yet -> nothing to resolve.
  assert.equal(alerts.resolveEndedRentalAlerts(conn, 2000).length, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE state='fired'").get().n, 1);
  // The rental is now ended=1 but was never resolved through evaluate (e.g. a crash between
  // observe's ended-commit and the alert evaluate) -> the sweep is the backstop.
  const sid = Number(conn.prepare("INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('quick','ended',1,1)").run().lastInsertRowid);
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name)
                VALUES (?, 42, 1, 'r', 100, 3, 1000, 30, 1, 100, 1, 'offline', 'w')`).run(sid);
  const ev = alerts.resolveEndedRentalAlerts(conn, 3000);
  assert.ok(ev.some((e) => e.kind === 'rental_offline' && e.event === 'resolved'));
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE state='fired'").get().n, 0, 'orphan resolved');
  conn.prepare('DELETE FROM rentals').run();
  conn.prepare('DELETE FROM sessions').run();
});

test('endpoint_down fires only after the sustained threshold and halts new rents', () => {
  const conn = db.get();
  const down = snap({ endpoint: { host: 'h', port: 1, ok: false } });
  assert.equal(alerts.evaluate(conn, down, {}, 0).length, 0, 'armed, not fired');
  assert.equal(alerts.newRentsHalted(conn), false, 'not halted while merely armed');
  assert.equal(alerts.evaluate(conn, down, {}, 100_000).length, 0, 'still within 150s');
  const fired = alerts.evaluate(conn, down, {}, 160_000);
  assert.ok(fired.some((e) => e.kind === 'endpoint_down' && e.event === 'fired'));
  assert.equal(alerts.newRentsHalted(conn), true, 'new rents halted once fired');
  // Recovery resolves and clears the gate.
  const up = snap({ endpoint: { host: 'h', port: 1, ok: true } });
  alerts.evaluate(conn, up, {}, 200_000);
  assert.equal(alerts.newRentsHalted(conn), false);
});

test('an endpoint probe blip (fetch_ok.endpoint false) does not arm endpoint_down', () => {
  const conn = db.get();
  const blip = { rentals: [], fetch_ok: { rentals: true, endpoint: false }, endpoint: { host: 'h', port: 1, ok: false } };
  alerts.evaluate(conn, blip, {}, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM alerts').get().n, 0, 'a blip never arms');
});

test('mrr_api_outage fires after 10 min of failing list fetches', () => {
  const conn = db.get();
  const bad = { rentals: [], fetch_ok: { rentals: false } };
  alerts.evaluate(conn, bad, {}, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE state='fired'").get().n, 0);
  const fired = alerts.evaluate(conn, bad, {}, 11 * 60 * 1000);
  assert.ok(fired.some((e) => e.kind === 'mrr_api_outage' && e.event === 'fired'));
});

test('balance_low fires when runway falls under the lead time', () => {
  const conn = db.get();
  // One rental costing 4800 sats over 3h => 1600 sats/h burn. Balance 2400 => 1.5h runway < 2h.
  const low = snap({
    rentals: [{ mrr_id: 1, paid_sats: 4700, fee_sats: 100, length_hours: 3, ended: false }],
    balance: { confirmed_sats: 2400, unconfirmed_sats: 0 },
  });
  alerts.evaluate(conn, low, {}, 0);
  const fired = alerts.evaluate(conn, low, {}, 3 * 60 * 1000);
  assert.ok(fired.some((e) => e.kind === 'balance_low' && e.event === 'fired'));
});

test('deposit_seen/deposit_cleared fire once on a balance increase', () => {
  const conn = db.get();
  const prev = { balance: { confirmed_sats: 1000, unconfirmed_sats: 0 } };
  const seen = snap({ balance: { confirmed_sats: 1000, unconfirmed_sats: 5000 } });
  const e1 = alerts.evaluate(conn, seen, prev, 100);
  assert.ok(e1.some((e) => e.kind === 'deposit_seen'));
  const cleared = snap({ balance: { confirmed_sats: 6000, unconfirmed_sats: 0 } });
  const e2 = alerts.evaluate(conn, cleared, { balance: seen.balance }, 200);
  assert.ok(e2.some((e) => e.kind === 'deposit_cleared'));
});

test('fireOnce dedups (dispute_window fires once per rental) and ack removes it from active', () => {
  const conn = db.get();
  const ev = alerts.fireOnce(conn, { kind: 'dispute_window', key: 'r9000001', now: 5000, context: { deadline_ts: 5000 + 12 * 3600, percent: 92 } });
  assert.ok(ev);
  assert.equal(alerts.fireOnce(conn, { kind: 'dispute_window', key: 'r9000001', now: 6000 }), null, 'no re-fire');
  const active = alerts.listActive(conn);
  assert.equal(active.length, 1);
  assert.equal(active[0].context.deadline_ts, 5000 + 12 * 3600);
  assert.equal(alerts.ack(conn, ev.id), true);
  assert.equal(alerts.listActive(conn).length, 0);
});

test('an offline rental fires rental_offline (warning), is idempotent, and resolves on heal', () => {
  const conn = db.get();
  const offline = snap({ rentals: [{ mrr_id: 7, rig_id: 3, health: 'offline', percent: 0, ended: false }] });
  const e1 = alerts.evaluate(conn, offline, {}, 1000);
  assert.equal(e1.filter((e) => e.kind === 'rental_offline' && e.event === 'fired').length, 1);
  assert.equal(conn.prepare("SELECT severity FROM alerts WHERE kind='rental_offline'").get().severity, 'warning');
  // Re-evaluate while still offline: no duplicate fire.
  const e2 = alerts.evaluate(conn, offline, {}, 2000);
  assert.equal(e2.length, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM alerts WHERE state='fired'").get().n, 1);
  // Health returns to healthy -> resolved.
  const healthy = snap({ rentals: [{ mrr_id: 7, rig_id: 3, health: 'healthy', percent: 98, ended: false }] });
  const e3 = alerts.evaluate(conn, healthy, {}, 3000);
  assert.ok(e3.some((e) => e.kind === 'rental_offline' && e.event === 'resolved'));
});

test('deposit min-delta boundary: 999 no fire, 1000/1001 fire; withdrawal no fire', () => {
  const conn = db.get();
  // Each call uses a distinct `now` so fireOnce keys never collide.
  const dep = (prevU, newU, prevC, newC, now) => alerts.evaluate(conn,
    snap({ balance: { unconfirmed_sats: newU, confirmed_sats: newC } }),
    { balance: { unconfirmed_sats: prevU, confirmed_sats: prevC } }, now);
  const seen = (evs) => evs.filter((e) => e.kind === 'deposit_seen').length;
  const cleared = (evs) => evs.filter((e) => e.kind === 'deposit_cleared').length;
  // deposit_seen (unconfirmed delta), confirmed held constant.
  assert.equal(seen(dep(0, 999, 0, 0, 1)), 0, 'delta 999 is below the min and does not fire');
  assert.equal(seen(dep(0, 1000, 0, 0, 2)), 1, 'delta exactly 1000 fires');
  assert.equal(seen(dep(0, 1001, 0, 0, 3)), 1, 'delta 1001 fires');
  assert.equal(seen(dep(5000, 4000, 0, 0, 4)), 0, 'a withdrawal (negative delta) does not fire');
  // deposit_cleared (confirmed delta), unconfirmed held constant.
  assert.equal(cleared(dep(0, 0, 0, 999, 5)), 0, 'delta 999 is below the min and does not fire');
  assert.equal(cleared(dep(0, 0, 0, 1000, 6)), 1, 'delta exactly 1000 fires');
  assert.equal(cleared(dep(0, 0, 0, 1001, 7)), 1, 'delta 1001 fires');
  assert.equal(cleared(dep(0, 0, 5000, 4000, 8)), 0, 'a withdrawal (negative delta) does not fire');
});

test('every fired alert kind has a real SEVERITY entry (ledger_discrepancy is not a kind)', () => {
  const firedKinds = [
    'rental_underdelivering', 'rental_offline', 'endpoint_down', 'mrr_api_outage', 'balance_low',
    'deposit_seen', 'deposit_cleared', 'dispute_window', 'session_ended', 'refund_received', 'needs_reconcile',
  ];
  for (const k of firedKinds) {
    assert.equal(typeof alerts.SEVERITY[k], 'string', `${k} has a severity`);
    assert.ok(alerts.SEVERITY[k].length > 0, `${k} severity is non-empty`);
  }
  // ledger_discrepancy is a buildSummary field, not an alert kind.
  assert.equal(alerts.SEVERITY.ledger_discrepancy, undefined);
});

test('a non-endpoint fired alert (mrr_api_outage) does not halt new rents', () => {
  const conn = db.get();
  const bad = { rentals: [], fetch_ok: { rentals: false } };
  alerts.evaluate(conn, bad, {}, 0);
  const fired = alerts.evaluate(conn, bad, {}, 11 * 60 * 1000);
  assert.ok(fired.some((e) => e.kind === 'mrr_api_outage' && e.event === 'fired'));
  assert.equal(alerts.newRentsHalted(conn), false, 'only endpoint_down gates new rents');
});

test('burnRateSatsPerHour: excludes ended, includes fees, guards length_hours, handles empty', () => {
  assert.equal(alerts.burnRateSatsPerHour([]), 0, 'empty array -> 0');
  assert.equal(alerts.burnRateSatsPerHour(), 0, 'undefined -> 0');
  assert.equal(alerts.burnRateSatsPerHour(null), 0, 'null -> 0');
  // Ended rentals contribute nothing.
  assert.equal(alerts.burnRateSatsPerHour([{ paid_sats: 3600, fee_sats: 0, length_hours: 1, ended: true }]), 0);
  // Fee-inclusive: (3500 + 100) / 2h = 1800/h.
  assert.equal(alerts.burnRateSatsPerHour([{ paid_sats: 3500, fee_sats: 100, length_hours: 2, ended: false }]), 1800);
  // length_hours <= 0 is guarded (no divide-by-zero, contributes 0).
  assert.equal(alerts.burnRateSatsPerHour([{ paid_sats: 5000, fee_sats: 0, length_hours: 0, ended: false }]), 0);
  // Sums across active rentals only.
  assert.equal(alerts.burnRateSatsPerHour([
    { paid_sats: 3600, fee_sats: 0, length_hours: 1, ended: false },
    { paid_sats: 100, fee_sats: 100, length_hours: 1, ended: false },
    { paid_sats: 9999, fee_sats: 0, length_hours: 1, ended: true },
  ]), 3800);
});

test('ack returns false for a nonexistent or already-resolved alert', () => {
  const conn = db.get();
  assert.equal(alerts.ack(conn, 999999), false, 'nonexistent id -> false');
  // Fire then resolve, then attempt to ack the resolved row.
  const fired = alerts.runTransition(conn, { kind: 'rental_offline', key: 'x', bad: true, now: 1 });
  assert.ok(fired && fired.event === 'fired');
  alerts.runTransition(conn, { kind: 'rental_offline', key: 'x', bad: false, now: 2 }); // resolve
  assert.equal(alerts.ack(conn, fired.id), false, 'an already-resolved alert cannot be acked');
});

test('balance_low resolves once runway recovers above the lead time', () => {
  const conn = db.get();
  const rentals = [{ mrr_id: 1, paid_sats: 4700, fee_sats: 100, length_hours: 3, ended: false }]; // 1600 sats/h
  const low = snap({ rentals, balance: { confirmed_sats: 2400, unconfirmed_sats: 0 } }); // 1.5h < 2h
  alerts.evaluate(conn, low, {}, 0);
  const fired = alerts.evaluate(conn, low, {}, 3 * 60 * 1000);
  assert.ok(fired.some((e) => e.kind === 'balance_low' && e.event === 'fired'));
  // Top up: 16000 sats => 10h runway, well above the 2h lead time.
  const ok = snap({ rentals, balance: { confirmed_sats: 16000, unconfirmed_sats: 0 } });
  const resolved = alerts.evaluate(conn, ok, {}, 4 * 60 * 1000);
  assert.ok(resolved.some((e) => e.kind === 'balance_low' && e.event === 'resolved'));
});

test('raiseReconcile dedups while active but RE-FIRES after resolve (fireOnce would suppress it)', () => {
  const c = db.get();
  assert.ok(alerts.raiseReconcile(c, { key: 'mrr1', now: 1000 }), 'first raise fires');
  assert.equal(alerts.raiseReconcile(c, { key: 'mrr1', now: 1001 }), null, 'a second raise while active is deduped');
  assert.equal(alerts.reconcileHalted(c), true);
  assert.equal(alerts.resolveReconcile(c, 'mrr1', 1002), true, 'resolve clears the active halt');
  assert.equal(alerts.reconcileHalted(c), false);
  assert.ok(alerts.raiseReconcile(c, { key: 'mrr1', now: 1003 }), 'a NEW same-key event must re-halt after a resolve');
  assert.equal(alerts.reconcileHalted(c), true);
});

test('raiseReconcile re-fires after an ACK too (a new ambiguous event on an acked key re-halts)', () => {
  const c = db.get();
  const ev = alerts.raiseReconcile(c, { key: 'sess1rig9', now: 1000 });
  alerts.ack(c, ev.id, 1001);
  assert.equal(alerts.reconcileHalted(c), false, 'acked -> not halted');
  assert.ok(alerts.raiseReconcile(c, { key: 'sess1rig9', now: 1002 }), 're-fires after ack');
  assert.equal(alerts.reconcileHalted(c), true);
});
