'use strict';
/*
 * Is the payout address in a stratum username mistyped?
 *
 * Nothing else in the chain will say. DATUM Gateway passes a miner's username through to
 * the pool without checking it ("TODO: Make sure the usernames are addresses"), so the
 * endpoint test gets work for a mistyped address exactly as it does for a good one, and
 * every rental then delivers in full, bills in full, and is credited to an address nobody
 * holds. That is the most likely way a payout address change goes wrong, and the only place
 * it can be caught is here, before it is saved.
 *
 * Only something that LOOKS like an address is checked: a Bech32 string with a Bitcoin
 * prefix, or a Base58 string of address length. Those carry a checksum, so a failure is a
 * typo for certain. Anything else (a pool account name, say) is left alone, since refusing
 * it would be guessing. The BLAKE2b chain uses Bitcoin's own address formats, which is
 * also what DATUM Gateway parses, so one check covers both algorithms.
 *
 * Network is not checked: a testnet address on mainnet is a valid address, just the wrong
 * one, and Pickhash does not know which network the gateway is on.
 */
const crypto = require('crypto');

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// P2PKH and P2SH version bytes, mainnet then testnet/regtest.
const BASE58_VERSIONS = new Set([0x00, 0x05, 0x6f, 0xc4]);

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** A segwit address (BIP173 / BIP350) with a valid checksum and witness program. */
function validBech32(addr) {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false;
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length || s.length > 90) return false;
  const hrp = s.slice(0, pos);
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const d = BECH32_CHARSET.indexOf(c);
    if (d < 0) return false;
    data.push(d);
  }
  const check = polymod([...hrpExpand(hrp), ...data]);
  const version = data[0];
  // v0 uses Bech32, v1+ Bech32m: the wrong one for its version is an invalid address.
  if (check !== (version === 0 ? BECH32_CONST : BECH32M_CONST)) return false;
  if (version > 16) return false;
  // Regroup the 5-bit program to bytes and check its length.
  let acc = 0;
  let bits = 0;
  const prog = [];
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) return false;
  if (prog.length < 2 || prog.length > 40) return false;
  if (version === 0 && prog.length !== 20 && prog.length !== 32) return false;
  return true;
}

/** A legacy P2PKH / P2SH address with a valid double-SHA256 checksum. */
function validBase58(addr) {
  let n = 0n;
  for (const c of addr) {
    const d = BASE58.indexOf(c);
    if (d < 0) return false;
    n = n * 58n + BigInt(d);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let lead = 0;
  while (addr[lead] === '1') lead += 1;
  const bytes = Buffer.concat([Buffer.alloc(lead), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')]);
  if (bytes.length !== 25) return false;
  const body = bytes.subarray(0, 21);
  const sum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest();
  return sum.subarray(0, 4).equals(bytes.subarray(21)) && BASE58_VERSIONS.has(body[0]);
}

/**
 * 'ok' for a valid address, 'invalid' for something shaped like one that fails its checksum,
 * 'not_an_address' for anything else (left for the pool to judge).
 */
function check(addr) {
  const a = String(addr || '');
  if (/^(bc|tb|bcrt)1/i.test(a)) return validBech32(a) ? 'ok' : 'invalid';
  if (/^[123mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return validBase58(a) ? 'ok' : 'invalid';
  return 'not_an_address';
}

module.exports = { check, validBech32, validBase58 };
