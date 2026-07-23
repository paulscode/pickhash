'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dispute = require('../engine/dispute');

// ---- parsePeriods ----

test('parsePeriods returns [] for the "none"/empty sentinels', () => {
  assert.deepEqual(dispute.parsePeriods('none'), []);
  assert.deepEqual(dispute.parsePeriods(''), []);
  assert.deepEqual(dispute.parsePeriods(null), []);
  assert.deepEqual(dispute.parsePeriods(undefined), []);
});

test('parsePeriods parses one and many [start,end] pairs as numbers', () => {
  assert.deepEqual(dispute.parsePeriods('[1000,2000]'), [{ start: 1000, end: 2000 }]);
  assert.deepEqual(dispute.parsePeriods('[1000,2000],[3000,4500]'), [
    { start: 1000, end: 2000 },
    { start: 3000, end: 4500 },
  ]);
});

test('parsePeriods swallows malformed input rather than throwing', () => {
  assert.deepEqual(dispute.parsePeriods('garbage'), []);
  assert.deepEqual(dispute.parsePeriods('[1000,'), []);   // truncated JSON
});

// ---- isDisputable (boundary at MRR's 93% auto-refund threshold; null = worst case) ----

test('isDisputable is true strictly below 93%, false at/above, and treats null as NOT disputable here', () => {
  assert.equal(dispute.isDisputable(92.99), true);
  assert.equal(dispute.isDisputable(0), true);
  assert.equal(dispute.isDisputable(93), false, 'exactly at threshold is not under-delivered');
  assert.equal(dispute.isDisputable(93.01), false);
  assert.equal(dispute.isDisputable(94), false, 'above the 93% auto-refund line -> not disputable');
  assert.equal(dispute.isDisputable(100), false);
  // null is handled by the CALLER as worst-case (runner/api OR it), not by isDisputable itself.
  assert.equal(dispute.isDisputable(null), false);
  assert.equal(dispute.isDisputable(undefined), false);
});

test('DISPUTE_THRESHOLD_PCT is the exported 93% boundary isDisputable uses', () => {
  assert.equal(dispute.DISPUTE_THRESHOLD_PCT, 93);
  assert.equal(dispute.isDisputable(dispute.DISPUTE_THRESHOLD_PCT), false);
  assert.equal(dispute.isDisputable(dispute.DISPUTE_THRESHOLD_PCT - 0.01), true);
});

// ---- disputeDeadlineTs (12h from MRR's own end ts; skew-proof) ----

test('disputeDeadlineTs adds exactly a 12h window to MRR end, coercing strings', () => {
  assert.equal(dispute.DISPUTE_WINDOW_SEC, 12 * 3600);
  assert.equal(dispute.disputeDeadlineTs(1_000_000), 1_000_000 + 43200);
  assert.equal(dispute.disputeDeadlineTs('1000000'), 1_043_200, 'string end ts is coerced, not concatenated');
});

// ---- disputeState (all boundaries; driven by the passed `now`, never the wall clock) ----

test('disputeState computes remaining and flips escalate/file_now/expired at their exact boundaries', () => {
  const deadline = 1_000_000;
  // remaining = deadline - now.
  assert.deepEqual(dispute.disputeState(deadline, deadline - 20000), { remaining_sec: 20000, escalate: false, file_now: false, expired: false });
  // escalate boundary: 3h = 10800s. AT the boundary escalates; one second more does not.
  assert.equal(dispute.disputeState(deadline, deadline - 10800).escalate, true);
  assert.equal(dispute.disputeState(deadline, deadline - 10801).escalate, false);
  // file_now boundary: 15min = 900s.
  assert.equal(dispute.disputeState(deadline, deadline - 900).file_now, true);
  assert.equal(dispute.disputeState(deadline, deadline - 901).file_now, false);
  // expired boundary: remaining <= 0.
  assert.equal(dispute.disputeState(deadline, deadline).expired, true);
  assert.equal(dispute.disputeState(deadline, deadline + 1).expired, true);
  assert.equal(dispute.disputeState(deadline, deadline - 1).expired, false);
});

test('disputeState uses only its arguments (a wrong local clock cannot move the window)', () => {
  // Same deadline+now yields the same state regardless of the real time -> skew-proof by construction.
  const a = dispute.disputeState(500, 100);
  const b = dispute.disputeState(500, 100);
  assert.deepEqual(a, b);
  assert.equal(a.remaining_sec, 400);
});

// ---- buildEvidence ----

const RENTAL = { mrr_id: 9000001, rig_id: 800001, rig_name: 'Example Rig', advertised_th: 100, end_ts: 1_700_000_000, length_hours: 3, avg_percent: 88.5 };

test('buildEvidence derives percent + delivered_th from the MRR detail and parses both offline series', () => {
  const detail = { hashrate: { average: { percent: '88.5' } }, end_unix: 1_700_000_500 };
  const graph = { chartdata: { offline: '[10,20]', pooloffline: '[30,40],[50,60]' } };
  const ev = dispute.buildEvidence(detail, graph, RENTAL, 1_700_000_600);
  assert.equal(ev.final_percent, 88.5);
  assert.equal(ev.delivered_th, 100 * 0.885);
  assert.equal(ev.end_ts, 1_700_000_500, 'detail.end_unix wins over rental.end_ts');
  assert.deepEqual(ev.offline_periods, [{ start: 10, end: 20 }]);
  assert.equal(ev.pooloffline_periods.length, 2);
  assert.equal(ev.captured_at, 1_700_000_600);
  assert.equal(ev.mrr_id, RENTAL.mrr_id);
});

test('buildEvidence falls back to the rental end ts and nulls percent/delivered when MRR reports none', () => {
  const ev = dispute.buildEvidence({ hashrate: { average: { percent: '' } } }, {}, RENTAL, null);
  assert.equal(ev.final_percent, null, 'empty-string percent -> null');
  assert.equal(ev.delivered_th, null, 'no percent -> no derived delivery');
  assert.equal(ev.end_ts, RENTAL.end_ts, 'falls back to the local rental end ts');
  assert.deepEqual(ev.offline_periods, []);
});

test('buildEvidence tolerates entirely missing detail/graph objects', () => {
  const ev = dispute.buildEvidence(null, null, RENTAL, 1);
  assert.equal(ev.final_percent, null);
  assert.equal(ev.end_ts, RENTAL.end_ts);
  assert.deepEqual(ev.offline_periods, []);
  assert.deepEqual(ev.pooloffline_periods, []);
});

// ---- evidenceText (the copy-paste ticket block) ----

test('evidenceText renders a ticket block with id, rig, formatted percent, TH, hours, and the refund ask', () => {
  const ev = { offline_periods: [{ start: 1, end: 2 }, { start: 3, end: 4 }] };
  const text = dispute.evidenceText(RENTAL, ev);
  assert.match(text, /Rental #9000001/);
  assert.match(text, /"Example Rig"/);
  assert.match(text, /88\.50% of the advertised 100 TH\/s over 3h/);
  assert.match(text, /2 offline period\(s\)/);
  assert.match(text, /prorated refund/);
});

test('evidenceText degrades to "?" for null percent/advertised and omits the offline line when there are none', () => {
  const text = dispute.evidenceText({ mrr_id: 7, rig_name: 'r', avg_percent: null, advertised_th: null, length_hours: 6 }, { offline_periods: [] });
  assert.match(text, /Delivered \?% of the advertised \? TH\/s over 6h/);
  assert.doesNotMatch(text, /offline period/);
  assert.match(text, /prorated refund/);
});

// ---- links ----

test('links point at the MRR rental page and the tickets page', () => {
  const l = dispute.links(9000001);
  assert.equal(l.rental, 'https://www.miningrigrentals.com/rental/9000001');
  assert.match(l.tickets, /miningrigrentals\.com\/account\/tickets$/);
});

// ---- Against a full capture fixture in the real MRR shape (synthetic; a clean 98.25% run) ----

test('buildEvidence + parsePeriods validate against the real MRR capture shape', () => {
  const capture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr/rental-9000001-final.json'), 'utf8'));
  assert.deepEqual(dispute.parsePeriods(capture.graph.chartdata.offline), [], 'a clean graph reports no offline periods');
  const rental = { mrr_id: 9000001, rig_id: 800001, rig_name: 'Example Rig', advertised_th: 250, end_ts: 1_700_010_800 };
  const detail = capture.detail || { hashrate: { average: { percent: '98.25' } }, end_unix: 1_700_010_800 };
  const ev = dispute.buildEvidence(detail, capture.graph, rental, 123);
  assert.equal(ev.final_percent, 98.25);
  assert.ok(Math.abs(ev.delivered_th - 250 * 0.9825) < 1e-6, 'delivered TH derived from the percent');
  assert.deepEqual(ev.offline_periods, []);
  assert.equal(ev.captured_at, 123);
});
