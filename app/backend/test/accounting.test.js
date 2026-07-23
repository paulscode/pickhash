'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const acct = require('../engine/accounting');

const tx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr/transactions.json'), 'utf8')).transactions;

// A sample rental #9000001: 1500 base + 45 fee, delivered 98.25% of 250 TH over 3h.
const rentals9000001 = [{ mrr_id: 9000001, rig_id: 800001, rig_name: 'rig', advertised_th: 250, length_hours: 3, avg_percent: 98.25, paid_sats: 1500, fee_sats: 45, refund_sats: 0 }];

test('reconcileSpend sums Payment + Rental Fee from the real ledger', () => {
  const r = acct.reconcileSpend(rentals9000001, tx);
  assert.equal(r.paidSats, 1500);
  assert.equal(r.feeSats, 45);
  assert.equal(r.missing.length, 0);
});

test('reconcileSpend flags a rental with no ledger Payment row', () => {
  const withGhost = [...rentals9000001, { mrr_id: 999, rig_id: 1, advertised_th: 100, length_hours: 3, avg_percent: 90, paid_sats: 1000, fee_sats: 30 }];
  const r = acct.reconcileSpend(withGhost, tx);
  assert.deepEqual(r.missing, [999]);
});

test('reconcileSpend flags NO discrepancy when no ledger was fetched (empty ledger != all missing)', () => {
  assert.equal(acct.reconcileSpend(rentals9000001, []).missing.length, 0);
  assert.equal(acct.buildSummary({ session: { id: 1 }, rentals: rentals9000001, ledger: [] }).ledger_discrepancy, null);
});

test('matchRefunds applies a duplicate tx id only once within a single batch', () => {
  const dup = [
    { id: '55', type: 'credit/refund', amount: '0.00000500', rental: '9000001' },
    { id: '55', type: 'credit/refund', amount: '0.00000500', rental: '9000001' },
  ];
  assert.equal(acct.matchRefunds(rentals9000001, dup).length, 1);
});

test('matchRefunds matches refund rows to rentals and is idempotent per tx id', () => {
  const refundRows = [{ id: '40000001', type: 'credit/refund', amount: '0.00000500', rental: '9000001' }];
  const m1 = acct.matchRefunds(rentals9000001, refundRows);
  assert.deepEqual(m1, [{ mrr_id: 9000001, refund_sats: 500, tx_id: '40000001' }]);
  // Already seen -> not matched again (no double-count).
  assert.equal(acct.matchRefunds(rentals9000001, refundRows, new Set(['40000001'])).length, 0);
  // A refund for an unknown rental is ignored.
  assert.equal(acct.matchRefunds(rentals9000001, [{ id: '2', type: 'credit/refund', amount: '0.00000100', rental: '777' }]).length, 0);
});

test('buildSummary reconciles spend and computes effective sats per TH-day delivered', () => {
  const s = acct.buildSummary({ session: { id: 1 }, rentals: rentals9000001, ledger: tx });
  assert.equal(s.gross_sats, 1545);              // 1500 + 45, from the ledger
  assert.equal(s.spent_sats, 1545);
  // delivered TH-hours = 250 * 0.9825 * 3
  const thH = 250 * 0.9825 * 3;
  assert.ok(Math.abs(s.delivered_th_hours - thH) < 1e-6);
  assert.ok(Math.abs(s.effective_sats_per_th_day - 1545 / (thH / 24)) < 1e-6);
  assert.equal(s.ledger_discrepancy, null);
});

test('buildSummary keeps recorded spend for a rental whose ledger row has not posted yet (partial ledger)', () => {
  // Two rentals; the ledger only carries #9000001's Payment/Fee. #950 must NOT vanish from
  // gross just because MRR hasn't posted its row — gross is reconciled per rental.
  const two = [
    rentals9000001[0],
    { mrr_id: 950, rig_id: 2, rig_name: 'r2', advertised_th: 100, length_hours: 3, avg_percent: 96, paid_sats: 1000, fee_sats: 30, refund_sats: 0 },
  ];
  const s = acct.buildSummary({ session: { id: 1 }, rentals: two, ledger: tx });   // tx has only 9000001's rows
  assert.equal(s.gross_sats, 1500 + 45 + 1000 + 30, 'ledgered rig from the ledger, un-ledgered rig from recorded');
  assert.equal(s.fee_sats, 45 + 30);
  assert.deepEqual(s.ledger_discrepancy, [950], 'the un-posted rig is still flagged as missing a ledger row');
});

test('a later refund lowers the session effective cost', () => {
  const refunded = [{ ...rentals9000001[0], refund_sats: 300 }];
  const s = acct.buildSummary({ session: { id: 1 }, rentals: refunded, ledger: tx });
  assert.equal(s.refund_sats, 300);
  assert.equal(s.spent_sats, 1545 - 300);
  assert.ok(s.effective_sats_per_th_day < 1545 / ((250 * 0.9825 * 3) / 24));
});

test('buildSummary: a rental that delivered nothing has null effective cost (not Infinity/NaN)', () => {
  // The disputed/fully-refunded case shown in History: avg_percent null -> 0 delivered
  // TH-hours, so thDays === 0. Effective sats/TH-day must be null, never Infinity or NaN.
  const dead = [{ mrr_id: 7, rig_id: 1, rig_name: 'r', advertised_th: 100, length_hours: 3, avg_percent: null, paid_sats: 1500, fee_sats: 45, refund_sats: 1545 }];
  const s = acct.buildSummary({ session: { id: 9 }, rentals: dead, ledger: [] });
  assert.equal(s.delivered_th_hours, 0);
  assert.equal(s.effective_sats_per_th_day, null);
  assert.ok(Number.isFinite(s.spent_sats));
});

test('matchRefunds sums only refund-typed rows, ignoring a Payment in the same batch', () => {
  const mixed = [
    { id: 'p1', type: 'Payment', amount: '0.00002000', rental: '9000001' },        // not a refund
    { id: 'r1', type: 'credit/refund', amount: '0.00000500', rental: '9000001' },  // the genuine refund
  ];
  assert.deepEqual(acct.matchRefunds(rentals9000001, mixed), [{ mrr_id: 9000001, refund_sats: 500, tx_id: 'r1' }]);
});

// A debit/refund is a reversal/clawback going the OTHER way. matchRefunds must never sum it
// as a positive refund — the reversal-safety invariant lives in the pure function, not only
// in the caller's ledger query — so a refund-then-reversal can't net to 2×.
test('matchRefunds ignores a debit/refund clawback (reversal-safety, not a positive refund)', () => {
  const clawback = [{ id: 'd1', type: 'debit/refund', amount: '0.00000500', rental: '9000001' }];
  assert.deepEqual(acct.matchRefunds(rentals9000001, clawback), []);
  // A genuine credit refund in the same batch is still matched; only the debit is dropped.
  const mixed = [...clawback, { id: 'c1', type: 'credit/refund', amount: '0.00000500', rental: '9000001' }];
  assert.deepEqual(acct.matchRefunds(rentals9000001, mixed), [{ mrr_id: 9000001, refund_sats: 500, tx_id: 'c1' }]);
});

test('reconcileSpend does not flag a zero-paid rental with no ledger row (paid_sats guard)', () => {
  // A free/zero-cost rental with no Payment row must NOT count as a missing ledger row.
  const free = { mrr_id: 888, rig_id: 2, advertised_th: 50, length_hours: 1, avg_percent: 95, paid_sats: 0, fee_sats: 0 };
  const r = acct.reconcileSpend([...rentals9000001, free], tx);
  assert.equal(r.missing.length, 0);   // 9000001 has ledger rows; 888 guarded out by paid_sats === 0
});

test('buildSummary: per_rig cost_sats uses the ledger gross (not recorded), so the breakdown sums to gross_sats', () => {
  // Recorded 1030, but the ledger reconciles this rental to 1545 (1500 + 45).
  const under = [{ mrr_id: 9000001, rig_id: 1, rig_name: 'r', advertised_th: 250, length_hours: 3, avg_percent: 98.25, paid_sats: 1000, fee_sats: 30, refund_sats: 0 }];
  const s = acct.buildSummary({ session: { id: 1 }, rentals: under, ledger: tx });
  assert.equal(s.gross_sats, 1545, 'session gross from the ledger');
  assert.equal(s.per_rig[0].cost_sats, 1545, 'per-rig cost matches the ledger, not the recorded 1030');
  assert.equal(s.per_rig.reduce((n, r) => n + r.cost_sats, 0), s.gross_sats, 'the breakdown sums to the total');
});
