'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecrets, hashPassword, verifyPassword, loadKeyMaterial } = require('../secrets');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-sec-')); }

test('encrypt/decrypt round-trips and binds the field name as AAD', () => {
  const dir = tmp();
  try {
    const s = createSecrets(dir);
    const blob = s.encrypt('mrr_secret', 'super-secret-value');
    assert.equal(s.decrypt('mrr_secret', blob), 'super-secret-value');
    // A blob decrypted under a different field name must fail, not leak plaintext.
    assert.equal(s.decrypt('mrr_key', blob), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a tampered or garbage blob decrypts to null and never throws', () => {
  const dir = tmp();
  try {
    const s = createSecrets(dir);
    const blob = s.encrypt('f', 'x');
    const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 0xff;
    assert.equal(s.decrypt('f', tampered), null);
    assert.equal(s.decrypt('f', Buffer.from('not a real blob')), null);
    assert.equal(s.decrypt('f', Buffer.alloc(0)), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('each encryption uses a fresh IV (same plaintext -> different ciphertext)', () => {
  const dir = tmp();
  try {
    const s = createSecrets(dir);
    const a = s.encrypt('f', 'same');
    const b = s.encrypt('f', 'same');
    assert.notEqual(a.toString('hex'), b.toString('hex'), 'IV reuse would produce identical blobs');
    assert.equal(s.decrypt('f', a), 'same');
    assert.equal(s.decrypt('f', b), 'same');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generates secret.key with 0600 perms on first use and reuses it', () => {
  const dir = tmp();
  try {
    const blob = createSecrets(dir).encrypt('f', 'v');
    const keyPath = path.join(dir, 'secret.key');
    assert.ok(fs.existsSync(keyPath));
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    // A fresh store instance reads the same key and decrypts the earlier blob.
    assert.equal(createSecrets(dir).decrypt('f', blob), 'v');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('APP_SEED mode derives the key from the seed, not the data dir', () => {
  const dir = tmp();
  const saved = { src: process.env.SECRET_SOURCE, seed: process.env.APP_SEED };
  try {
    process.env.SECRET_SOURCE = 'app-seed';
    process.env.APP_SEED = 'the-umbrel-app-seed';
    const blob = createSecrets(dir).encrypt('f', 'v');
    assert.equal(fs.existsSync(path.join(dir, 'secret.key')), false, 'no key file in app-seed mode');
    // Same seed, different dir -> still decrypts.
    assert.equal(createSecrets(tmp()).decrypt('f', blob), 'v');
    // Different seed -> cannot decrypt (data-dir backup alone is useless).
    process.env.APP_SEED = 'a-completely-different-seed';
    assert.equal(createSecrets(tmp()).decrypt('f', blob), null);
  } finally {
    if (saved.src === undefined) delete process.env.SECRET_SOURCE; else process.env.SECRET_SOURCE = saved.src;
    if (saved.seed === undefined) delete process.env.APP_SEED; else process.env.APP_SEED = saved.seed;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scrypt password hashing verifies only the correct password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('', stored), false);
  // Random salt -> two hashes of the same password differ.
  assert.notEqual(hashPassword('x').toString('hex'), hashPassword('x').toString('hex'));
});

test('password hashing: versioned round-trip and constant-time reject', () => {
  const blob = hashPassword('correct horse battery');
  assert.equal(blob.length, 1 + 16 + 32, 'version || salt || hash');
  assert.equal(blob[0], 1, 'current version tag');
  assert.equal(verifyPassword('correct horse battery', blob), true);
  assert.equal(verifyPassword('wrong', blob), false);
});

test('password hashing: a pre-versioning (legacy salt||hash) blob still verifies', () => {
  // Reconstruct the old format: 16-byte salt || 32-byte scrypt hash at the default cost.
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const legacy = Buffer.concat([salt, crypto.scryptSync('legacy-pass', salt, 32)]);
  assert.equal(legacy.length, 48, 'legacy blob has no version byte');
  assert.equal(verifyPassword('legacy-pass', legacy), true, 'old hashes keep working');
  assert.equal(verifyPassword('nope', legacy), false);
});

test('loadKeyMaterial regenerates a wrong-size (corrupt) secret.key rather than using it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-key-'));
  try {
    const keyPath = path.join(dir, 'secret.key');
    fs.writeFileSync(keyPath, Buffer.alloc(7));   // truncated/corrupt (not 32 bytes)
    const errs = [];
    const origErr = console.error; console.error = (m) => errs.push(String(m));
    let key;
    try { key = loadKeyMaterial(dir); } finally { console.error = origErr; }
    assert.equal(key.length, 32, 'regenerated a full-size key');
    assert.equal(fs.readFileSync(keyPath).length, 32, 'the corrupt file was overwritten');
    assert.ok(errs.some((m) => /wrong size|corrupt/i.test(m)), 'the regeneration is logged loudly');
    // Reloading now returns the SAME (persisted) key, not a fresh one.
    assert.deepEqual(loadKeyMaterial(dir), key, 'a valid key is reused, not regenerated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
