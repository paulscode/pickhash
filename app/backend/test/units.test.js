'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const units = require('../units');

test('toTh converts hash units to TH/s', () => {
  assert.equal(units.toTh(1, 'th'), 1);
  assert.equal(units.toTh(1000, 'gh'), 1);   // 1000 GH = 1 TH
  assert.equal(units.toTh(1, 'ph'), 1000);   // 1 PH = 1000 TH (advertised sha256ab often in PH)
  assert.equal(units.toTh(1e6, 'mh'), 1);    // 1,000,000 MH = 1 TH (last_Xmin often in MH)
  assert.equal(units.toTh(0, 'th'), 0);
});

test('toTh is case-insensitive and rejects unknown units', () => {
  assert.equal(units.toTh(1, 'TH'), 1);
  assert.throws(() => units.toTh(1, 'zh'), /unknown hash unit/);
});

test('fromTh is the inverse of toTh', () => {
  for (const unit of ['mh', 'gh', 'th', 'ph']) {
    const back = units.toTh(units.fromTh(5, unit), unit);
    assert.ok(Math.abs(back - 5) < 1e-9, `${unit} round-trips`);
  }
});

test('perThFactor gives TH-per-unit and rejects unknown units', () => {
  assert.equal(units.perThFactor('th'), 1);
  assert.equal(units.perThFactor('ph'), 1000);        // 1 PH = 1000 TH (sha256ab price unit)
  assert.equal(units.perThFactor('eh'), 1e6);
  assert.equal(units.perThFactor('mh'), 1e-6);
  assert.equal(units.perThFactor('GH'), 1e-3);        // case-insensitive
  assert.throws(() => units.perThFactor('zz'), /unknown hash unit/);
});

test('fromTh rejects unknown units', () => {
  assert.throws(() => units.fromTh(1, 'zz'), /unknown hash unit/);
});

test('btc <-> sats round-trips as integers', () => {
  assert.equal(units.btcToSats(0.0005), 50000);
  assert.equal(units.btcToSats(1), 100000000);
  assert.equal(units.btcToSats(0.00000001), 1);        // 1 sat
  assert.equal(units.satsToBtc(50000), 0.0005);
  assert.ok(Number.isInteger(units.btcToSats(0.12345678)));
});
