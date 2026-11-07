'use strict';
/*
 * The payout address check run when an endpoint is saved. A mistyped address passes every
 * probe (the gateway does not check usernames) and is then credited with everything the
 * rentals mine, so this is the only place it can be stopped.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const address = require('../address');

test('valid Bitcoin-format addresses pass, in every form the gateway parses', () => {
  for (const a of [
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',                        // P2WPKH (BIP173)
    'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',                        // all upper case is valid
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',    // P2TR (BIP350)
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',                        // testnet
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',                                // P2PKH
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',                                // P2SH
  ]) assert.equal(address.check(a), 'ok', a);
});

test('one wrong character, or the wrong checksum variant, is caught', () => {
  for (const a of [
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',   // v0 program with a Bech32m checksum
    'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',   // mixed case
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3',
    'bc1qaddr',
  ]) assert.equal(address.check(a), 'invalid', a);
});

test('a username that is not shaped like an address is left for the pool to judge', () => {
  for (const a of ['phash', 'myaccount', 'worker1', '']) assert.equal(address.check(a), 'not_an_address', a);
});
