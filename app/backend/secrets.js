'use strict';
/*
 * Secret storage: AES-256-GCM for spend credentials (the MRR key/secret), and scrypt
 * for the dashboard password.
 *
 * The encryption key is sourced from OUTSIDE the database so a stolen DB — or, on
 * Umbrel, a stolen data-dir backup — can't decrypt on its own:
 *   - SECRET_SOURCE=app-seed -> derive the key from APP_SEED (kept out of the data dir)
 *   - otherwise              -> ${DATA_DIR}/secret.key (0600), generated on first boot
 *
 * Every encryption uses a FRESH RANDOM 96-bit IV (never reused — GCM IV reuse is a
 * catastrophic break). Blob layout: iv(12) || tag(16) || ciphertext. The field name
 * is bound in as GCM additional authenticated data, so a blob can't be moved between
 * fields. Any decrypt failure is treated as "unset" (re-run setup), never a crash.
 */
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;
const KEY_LEN = 32;

// Dashboard-password hashing cost. N=2^16 (~64 MB, r=8) is well above the Node default and stays
// safe on low-RAM appliance hardware; login is single-user and infrequent, so the cost is only ever
// paid on an actual attempt. Hashes are length-tagged so a stronger cost can be introduced later
// without breaking existing blobs: a new blob is `version(1) || salt(16) || hash(32)` (49 bytes);
// a pre-versioning blob is `salt(16) || hash(32)` (48 bytes) and still verifies at the old cost.
const PW_VERSION = 1;
const SCRYPT_OPTS = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function loadKeyMaterial(dataDir) {
  if (process.env.SECRET_SOURCE === 'app-seed') {
    const seed = process.env.APP_SEED;
    if (!seed) throw new Error('SECRET_SOURCE=app-seed but APP_SEED is not set');
    // Derive a 32-byte key from the high-entropy seed with a fixed domain-separation salt.
    return crypto.scryptSync(seed, 'pickhash/secret-key/v1', KEY_LEN);
  }
  const keyPath = path.join(dataDir, 'secret.key');
  let existed = false;
  try {
    const k = fs.readFileSync(keyPath);
    if (k.length === KEY_LEN) return k;
    existed = true;   // present but wrong size — corrupt/truncated
  } catch { /* not present or unreadable — generate below */ }
  if (existed) {
    // Regenerating orphans any previously-encrypted credentials; make it loud so the
    // operator knows why the app suddenly reports "not configured".
    console.error('[pickhash] secret.key is present but the wrong size (corrupt?) — regenerating; stored credentials will need to be re-entered.');
  }
  const key = crypto.randomBytes(KEY_LEN);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Tighten the data dir even if it pre-existed (the entrypoint may have created it) — it holds the
  // key, the SQLite DB with the ciphertext, and config. Best-effort on non-POSIX filesystems.
  try { fs.chmodSync(dataDir, 0o700); } catch { /* non-POSIX filesystem */ }
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* non-POSIX filesystem */ }
  return key;
}

/** A secrets store bound to a data dir. The key is loaded once, lazily. */
function createSecrets(dataDir) {
  let key = null;
  const getKey = () => (key || (key = loadKeyMaterial(dataDir)));

  return {
    /** Encrypt plaintext for `field`. Returns a Buffer blob for the `secrets` table. */
    encrypt(field, plaintext) {
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
      cipher.setAAD(Buffer.from(field, 'utf8'));
      const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]);
    },

    /** Decrypt a blob for `field`. Returns the string, or null on ANY failure. */
    decrypt(field, blob) {
      try {
        const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
        const iv = buf.subarray(0, IV_LEN);
        const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
        const ct = buf.subarray(IV_LEN + TAG_LEN);
        const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
        decipher.setAAD(Buffer.from(field, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Dashboard password hashing. Stores version || salt || hash; verify is constant-time. */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_OPTS);
  return Buffer.concat([Buffer.from([PW_VERSION]), salt, hash]);
}

function verifyPassword(password, stored) {
  try {
    const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
    let salt;
    let expected;
    let opts;
    if (buf.length === 1 + SALT_LEN + KEY_LEN && buf[0] === PW_VERSION) {
      salt = buf.subarray(1, 1 + SALT_LEN);
      expected = buf.subarray(1 + SALT_LEN);
      opts = SCRYPT_OPTS;
    } else {
      // Pre-versioning blob (salt || hash) at the old default cost — still accepted.
      salt = buf.subarray(0, SALT_LEN);
      expected = buf.subarray(SALT_LEN);
      opts = undefined;
    }
    const actual = crypto.scryptSync(password, salt, expected.length, opts);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = { createSecrets, hashPassword, verifyPassword, loadKeyMaterial };
