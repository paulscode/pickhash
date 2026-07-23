'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mrrSource = require('../engine/delivery/mrr-source');
const delivery = require('../engine/delivery');

const rentalDetail = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr/rental-created.json'), 'utf8'));

test('mrr-source reads percent and derives delivered TH from advertised x percent', () => {
  // The final #9000001 snapshot delivered 98.25% of 250 TH advertised.
  const detail = { hashrate: { average: { percent: '98.25', hash: '0.23906', type: 'ph' } } };
  const r = mrrSource.readDetail(detail, 250);
  assert.equal(r.percent, 98.25);
  assert.ok(Math.abs(r.deliveredTh - 250 * 0.9825) < 1e-6);
  assert.equal(r.rawHash, '0.23906');
});

test('mrr-source tolerates a ramp-time 0 average and missing fields', () => {
  const r = mrrSource.readDetail(rentalDetail, 250);   // fixture average.percent = "0.00"
  assert.equal(r.percent, 0);
  assert.equal(r.deliveredTh, 0);
  assert.deepEqual(mrrSource.readDetail(null, 100), { percent: null, deliveredTh: null, rawHash: null });
});

test('resolveSignal v1 is MRR-only: authoritative === fast, source mrr', () => {
  const detail = { hashrate: { average: { percent: '94.5' } } };
  const s = delivery.resolveSignal({ detail, advertisedTh: 200, prevPercent: 90, now: 5 });
  assert.equal(s.source, 'mrr');
  assert.equal(s.authoritative, 94.5);
  assert.equal(s.fast, s.authoritative, 'no fast source in v1');
  assert.equal(s.ts, 5);
  assert.ok(Math.abs(s.deliveredTh - 189) < 1e-9);
});

test('resolveSignal freshness: a changed reading is fresh; unchanged or null is not', () => {
  const mk = (percent, prevPercent) => delivery.resolveSignal({
    detail: percent == null ? null : { hashrate: { average: { percent: String(percent) } } },
    advertisedTh: 100, prevPercent, now: 1,
  });
  assert.equal(mk(95, 90).fresh, true, 'changed -> fresh');
  assert.equal(mk(95, 95).fresh, false, 'unchanged (unrefreshed average) -> not fresh');
  assert.equal(mk(null, 95).fresh, false, 'blip (null) -> not fresh');
  assert.equal(mk(95, undefined).fresh, true, 'first reading -> fresh');
});

test('readDetail: a valid percent with null advertisedTh yields deliveredTh null', () => {
  const r = mrrSource.readDetail({ hashrate: { average: { percent: '98.25' } } }, null);
  assert.equal(r.percent, 98.25, 'percent still parsed');
  assert.equal(r.deliveredTh, null, 'cannot derive TH without an advertised value');
});

test("readDetail: an empty-string percent is null (num('') -> null)", () => {
  const r = mrrSource.readDetail({ hashrate: { average: { percent: '' } } }, 100);
  assert.equal(r.percent, null, "num('') -> null, not 0");
  assert.equal(r.deliveredTh, null);
});

test('resolveSignal freshness: a first reading with prevPercent null is fresh', () => {
  const s = delivery.resolveSignal({
    detail: { hashrate: { average: { percent: '95' } } },
    advertisedTh: 100, prevPercent: null, now: 1,
  });
  assert.equal(s.fresh, true, 'null (never-observed) prevPercent is treated as a fresh reading');
});

test("readDetail: a non-numeric percent ('N/A') maps to null, not NaN (a NaN would read as fresh and reset timers)", () => {
  const r = mrrSource.readDetail({ hashrate: { average: { percent: 'N/A' } } }, 100);
  assert.equal(r.percent, null);
  assert.equal(r.deliveredTh, null);
  const s = delivery.resolveSignal({ detail: { hashrate: { average: { percent: 'N/A' } } }, advertisedTh: 100, prevPercent: 90, now: 5 });
  assert.equal(s.authoritative, null);
  assert.equal(s.fresh, false, 'a garbage reading is a blip, never fresh');
});
