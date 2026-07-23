'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const deposit = require('../deposit');

test('depositTransitions fires seen on new unconfirmed and cleared on new confirmed', () => {
  // Fresh deposit appears unconfirmed.
  let ev = deposit.depositTransitions({ confirmed_sats: 0, unconfirmed_sats: 0 }, { confirmed_sats: 0, unconfirmed_sats: 50000 });
  assert.deepEqual(ev.map((e) => e.kind), ['deposit_seen']);
  assert.equal(ev[0].delta_sats, 50000);

  // It confirms.
  ev = deposit.depositTransitions({ confirmed_sats: 0, unconfirmed_sats: 50000 }, { confirmed_sats: 50000, unconfirmed_sats: 0 });
  assert.deepEqual(ev.map((e) => e.kind), ['deposit_cleared']);

  // No change -> no events.
  assert.equal(deposit.depositTransitions({ confirmed_sats: 50000, unconfirmed_sats: 0 }, { confirmed_sats: 50000, unconfirmed_sats: 0 }).length, 0);

  // A brand-new deposit that appears already confirmed fires both.
  ev = deposit.depositTransitions(undefined, { confirmed_sats: 100000, unconfirmed_sats: 20000 });
  assert.deepEqual(ev.map((e) => e.kind).sort(), ['deposit_cleared', 'deposit_seen']);
});

test('extractBtcAddress handles the documented and stringy shapes', () => {
  assert.equal(deposit.extractBtcAddress({ deposit: { BTC: { address: 'bc1qx' } } }), 'bc1qx');
  assert.equal(deposit.extractBtcAddress({ deposit: { BTC: 'bc1qy' } }), 'bc1qy');
  assert.equal(deposit.extractBtcAddress({ btc_deposit_address: 'bc1qz' }), 'bc1qz');
  assert.equal(deposit.extractBtcAddress({}), null);
  assert.equal(deposit.extractBtcAddress(null), null);
});

test('balanceToSats converts BTC strings to integer sats', () => {
  assert.deepEqual(deposit.balanceToSats({ BTC: { confirmed: '0.00050000', unconfirmed: '0.00000000' } }),
    { confirmed_sats: 50000, unconfirmed_sats: 0 });
});

test('pollOnce writes an alert row on a transition and nothing when unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-dep-'));
  try {
    db.open(dir);
    const conn = db.get();
    let bal = { BTC: { confirmed: '0.00000000', unconfirmed: '0.00050000' } };
    const client = { get: async (p) => (p === '/account/balance' ? bal : {}) };

    let r = await deposit.pollOnce(conn, client);
    assert.deepEqual(r.events.map((e) => e.kind), ['deposit_seen']);
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind='deposit_seen'").get().n, 1);

    // Same balance again -> no new event/alert.
    r = await deposit.pollOnce(conn, client);
    assert.equal(r.events.length, 0);

    // It confirms -> deposit_cleared.
    bal = { BTC: { confirmed: '0.00050000', unconfirmed: '0.00000000' } };
    r = await deposit.pollOnce(conn, client);
    assert.deepEqual(r.events.map((e) => e.kind), ['deposit_cleared']);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
