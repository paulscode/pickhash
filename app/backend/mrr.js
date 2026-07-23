'use strict';
/*
 * Wiring between the API and the MRR client: build a client from supplied or stored
 * credentials, and store credentials encrypted. Keeps the crypto + client plumbing
 * out of the route handlers. The base URL is overridable (MRR_BASE_URL) for tests.
 */
const { MrrClient, dbNonceStore } = require('./mrr-client');
const { createSecrets } = require('./secrets');

function baseUrl() {
  const u = process.env.MRR_BASE_URL;
  if (!u) return undefined;   // the client defaults to the real https base
  // The credentials + HMAC signature are sent to this base; a plaintext http:// base would leak
  // them. Only allow a non-HTTPS override behind an explicit opt-in used by the local test mock.
  if (!/^https:\/\//i.test(u) && process.env.ALLOW_INSECURE_MRR !== '1') {
    throw new Error('MRR_BASE_URL must be https://');
  }
  return u;
}

/** A client using the given credentials (used to validate a new key during setup). */
function clientWith(conn, key, secret) {
  return new MrrClient({ key, secret, nonceStore: dbNonceStore(conn), baseUrl: baseUrl() });
}

/** Store the MRR credentials encrypted (upsert). */
function storeCreds(conn, dataDir, key, secret) {
  const s = createSecrets(dataDir);
  const now = Math.floor(Date.now() / 1000);
  const up = conn.prepare(
    `INSERT INTO secrets (name, blob, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  );
  up.run('mrr_key', s.encrypt('mrr_key', key), now);
  up.run('mrr_secret', s.encrypt('mrr_secret', secret), now);
  cached = null;   // force a rebuild with the new credentials (updated_at has 1s granularity)
}

// A single shared client from the stored credentials. This MUST be a singleton: the
// client serializes all calls through one queue for nonce safety, so building a new
// one per request would let concurrent requests race the per-key nonce. Cached by the
// connection + the secret's updated_at, so it rebuilds when the credentials change.
let cached = null;

/** The shared client from the stored (encrypted) credentials, or null if unset/undecryptable. */
function clientFromStore(conn, dataDir) {
  const row = conn.prepare("SELECT updated_at FROM secrets WHERE name = 'mrr_secret'").get();
  const fp = row ? String(row.updated_at) : null;
  if (!fp) { cached = null; return null; }
  if (cached && cached.conn === conn && cached.fp === fp) return cached.client;

  const s = createSecrets(dataDir);
  const keyRow = conn.prepare('SELECT blob FROM secrets WHERE name = ?').get('mrr_key');
  const secRow = conn.prepare('SELECT blob FROM secrets WHERE name = ?').get('mrr_secret');
  if (!keyRow || !secRow) { cached = null; return null; }
  const key = s.decrypt('mrr_key', keyRow.blob);
  const secret = s.decrypt('mrr_secret', secRow.blob);
  if (!key || !secret) { cached = null; return null; }

  const client = clientWith(conn, key, secret);
  cached = { conn, fp, client };
  return client;
}

/** Test-only: drop the cached singleton. */
function _resetClient() { cached = null; }

module.exports = { clientWith, clientFromStore, storeCreds, baseUrl, _resetClient };
