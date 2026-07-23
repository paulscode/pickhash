'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const refunds = require('../engine/refunds');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-refunds-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const c = db.get();
  c.prepare('DELETE FROM applied_refunds').run();
  c.prepare('DELETE FROM alerts').run();
  c.prepare('DELETE FROM rentals').run();
  c.prepare('DELETE FROM sessions').run();
});

test('recomputeSession reconciles against the ledger so a refund does not revert gross to recorded', async () => {
  const c = db.get();
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, spent_sats, created_at, started_at) VALUES ('quick','ended',1020,1,1)").run().lastInsertRowid);
  // Recorded 1000+20 = 1020; MRR actually billed 1050+20 = 1070; a 100-sat refund already applied.
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, refund_sats, worker_name)
             VALUES (?, 9000001, 1, 'r', 100, 3, 1000, 20, 100, 1, 'healthy', 96, 100, 'w')`).run(sid);
  const client = {
    async get(p) {
      if (p === '/account/transactions') {
        return { transactions: [
          { id: '1', type: 'Payment', amount: -0.0000105, rental: '9000001' },   // 1050 sats (more than recorded)
          { id: '2', type: 'Rental Fee', amount: -0.0000002, rental: '9000001' }, // 20 sats
        ] };
      }
      throw new Error('unexpected ' + p);
    },
  };
  await refunds.recomputeSession(c, sid, client);
  const row = c.prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sid);
  assert.equal(row.spent_sats, 970, 'ledger gross 1070 minus the 100 refund — not recorded 1020-100=920');
});

function seed(nowSec) {
  const c = db.get();
  const sid = Number(c.prepare("INSERT INTO sessions (mode, state, spent_sats, created_at, started_at) VALUES ('quick','ended',10000,1,1)").run().lastInsertRowid);
  // Two ended rentals, gross 5000 + 5000; rig avg 88% (under-delivered -> refundable).
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?, 100, 1, 'r', 100, 3, 4850, 150, ?, 1, 'ended', 88, 'w')`).run(sid, nowSec - 3600);
  c.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, end_ts, ended, health, avg_percent, worker_name)
             VALUES (?, 101, 1, 'r', 100, 3, 4850, 150, ?, 1, 'ended', 97, 'w')`).run(sid, nowSec - 3600);
  return sid;
}

// A client returning a refund ledger row for rental 100.
function client(rows) {
  return { async get(p, params) {
    if (p === '/account/transactions' && params.type === 'credit/refund') return { transactions: rows };
    if (p === '/account/transactions') return { transactions: [] };
    throw new Error('unexpected ' + p);
  } };
}

test('armWatch sets a refund watch window on ended rentals only', () => {
  const now = 1_800_000_000;
  const sid = seed(now);
  refunds.armWatch(db.get(), 14);
  const rows = db.get().prepare('SELECT mrr_id, refund_watch_until FROM rentals WHERE session_id = ?').all(sid);
  assert.ok(rows.every((r) => r.refund_watch_until === (now - 3600) + 14 * 86400));
});

test('reconcile applies a refund, lowers session spend, fires refund_received, idempotent', async () => {
  const now = 1_800_000_000;
  const sid = seed(now);
  const refundRow = [{ id: '90001', type: 'credit/refund', amount: '0.00000600', rental: '100' }];   // 600 sats

  const ev1 = await refunds.reconcile(db.get(), client(refundRow), now, 14);
  assert.ok(ev1.some((e) => e.kind === 'refund_received'));
  const r = db.get().prepare('SELECT refund_sats, refunded FROM rentals WHERE mrr_id = 100').get();
  assert.equal(r.refund_sats, 600);
  assert.equal(r.refunded, 1);
  // Session spend recomputed down by the refund: gross 10000 - 600 = 9400.
  assert.equal(db.get().prepare('SELECT spent_sats FROM sessions WHERE id = ?').get(sid).spent_sats, 9400);

  // Re-seeing the same tx id does nothing (idempotent).
  const ev2 = await refunds.reconcile(db.get(), client(refundRow), now, 14);
  assert.equal(ev2.length, 0);
  assert.equal(db.get().prepare('SELECT refund_sats FROM rentals WHERE mrr_id = 100').get().refund_sats, 600);
});

test('reconcile applies a duplicate refund row within one batch only once', async () => {
  const now = 1_800_000_000;
  seed(now);
  const dup = [
    { id: 'X1', type: 'credit/refund', amount: '0.00000500', rental: '100' },
    { id: 'X1', type: 'credit/refund', amount: '0.00000500', rental: '100' },
  ];
  await refunds.reconcile(db.get(), client(dup), now, 14);
  assert.equal(db.get().prepare('SELECT refund_sats FROM rentals WHERE mrr_id = 100').get().refund_sats, 500);
});

test('reconcile does not re-credit a tx already in applied_refunds (DB gate blocks double-credit)', async () => {
  const now = 1_800_000_000;
  seed(now);
  // Simulate a refund that was applied on a PRIOR process/run: its idempotency row exists in
  // applied_refunds, but this rental's refund_sats was never bumped here and no alert exists.
  // The tx is NOT in any in-memory seen set the test maintains; only the DB carries it.
  db.get().prepare('INSERT INTO applied_refunds (tx_id, rental_mrr_id, sats, applied_at) VALUES (?,?,?,?)')
    .run('SEEDED-TX', 100, 500, now);
  const row = [{ id: 'SEEDED-TX', type: 'credit/refund', amount: '0.00000500', rental: '100' }];

  const ev = await refunds.reconcile(db.get(), client(row), now, 14);
  assert.equal(ev.length, 0, 'no second refund_received event for an already-applied tx');
  const r = db.get().prepare('SELECT refund_sats, refunded FROM rentals WHERE mrr_id = 100').get();
  assert.equal(r.refund_sats, 0, 'refund_sats not incremented a second time');
  assert.equal(r.refunded, 0);
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'refund_received'").get().n, 0, 'no refund_received alert row written');
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM applied_refunds WHERE tx_id = ?').get('SEEDED-TX').n, 1, 'still a single idempotency row');
});

test('reconcile is blip-safe: a failed ledger poll is a no-op', async () => {
  const now = 1_800_000_000;
  seed(now);
  const throwing = { async get() { throw new Error('ledger poll failed'); } };
  const ev = await refunds.reconcile(db.get(), throwing, now, 14);
  assert.deepEqual(ev, [], 'no events on a rejected ledger poll');
  const r = db.get().prepare('SELECT refund_sats, refunded FROM rentals WHERE mrr_id = 100').get();
  assert.equal(r.refund_sats, 0, 'no refund applied');
  assert.equal(r.refunded, 0, 'watch/application state untouched');
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM applied_refunds').get().n, 0, 'nothing written to the idempotency ledger');
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 0, 'no alert fired');
});

test('a rental past its watch window is no longer polled', async () => {
  const now = 1_800_000_000;
  const sid = seed(now);
  // Expire the watch window.
  db.get().prepare('UPDATE rentals SET refund_watch_until = ? WHERE session_id = ?').run(now - 1, sid);
  let asked = false;
  const spyClient = { async get(p) { if (p === '/account/transactions') asked = true; return { transactions: [] }; } };
  await refunds.reconcile(db.get(), spyClient, now, 14);
  assert.equal(asked, false, 'no ledger poll when nothing is within its watch window');
});
