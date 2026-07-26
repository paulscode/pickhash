'use strict';
/*
 * DuckDNS integration. Gives a raw-IP stratum endpoint a free, stable DNS name so MRR treats it as a
 * hostname — MRR does not refund rentals pointed at bare IPs — and so a VPS IP change is absorbed at
 * the DNS layer (one DuckDNS update) instead of rewriting every rental's MRR pool.
 *
 * DuckDNS updates via a single GET; the `ip` param overrides the request's source IP, so this runs
 * from here, not the VPS. We only ever trust the name AFTER resolving it back to the expected IP —
 * never hand MRR a name that doesn't yet point where we expect. Zero dependencies (global fetch +
 * node:dns). The token is stored encrypted in the `secrets` table, exactly like the MRR credentials,
 * and never leaves the backend.
 */
const dns = require('node:dns').promises;
const net = require('node:net');
const { createSecrets } = require('./secrets');
const config = require('./config');

const KEEPALIVE_SEC = 24 * 3600;   // re-push at least daily so DuckDNS never reclaims the name for inactivity

const UPDATE_BASE = 'https://www.duckdns.org/update';
const DOMAIN_SUFFIX = '.duckdns.org';

/** Normalize user input to the bare DuckDNS label (strip a pasted ".duckdns.org" / URL, lowercase). */
function normalizeSubdomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');   // tolerate a pasted URL
  if (s.endsWith(DOMAIN_SUFFIX)) s = s.slice(0, -DOMAIN_SUFFIX.length);
  return s;
}

/** The FQDN for a (normalized) subdomain. */
function fqdn(subdomain) { return `${normalizeSubdomain(subdomain)}${DOMAIN_SUFFIX}`; }

/** Valid DuckDNS label: letters/digits/hyphen, 1-63 chars, no leading/trailing hyphen. */
function validSubdomain(sub) { return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizeSubdomain(sub)); }

/**
 * Push an IP to DuckDNS. Returns { ok, response }. DuckDNS takes ip= (v4) / ipv6= (v6) and answers
 * with the literal body "OK" or "KO" (KO = bad token or domain). Best-effort + timeout-bounded.
 */
async function update(subdomain, token, ip, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const sub = normalizeSubdomain(subdomain);
  const v6 = String(ip).includes(':');
  const params = new URLSearchParams({ domains: sub, token: String(token || '') });
  if (v6) params.set('ipv6', ip); else params.set('ip', ip);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${UPDATE_BASE}?${params}`, { signal: ctrl.signal });
    const body = (await res.text()).trim();
    return { ok: res.ok && body.toUpperCase().startsWith('OK'), response: body };
  } catch (e) {
    return { ok: false, response: `error:${e.name || 'fetch_failed'}` };
  } finally { clearTimeout(timer); }
}

/**
 * Resolve the name and confirm it points at expectedIp, retrying for propagation. Uses resolve4/6 (a
 * real DNS query, not the hosts file), so it reflects what a miner/MRR would get. Returns true on the
 * first matching lookup.
 */
async function verifyResolves(subdomain, expectedIp, { retries = 6, delayMs = 2000, sleep } = {}) {
  const name = fqdn(subdomain);
  const v6 = String(expectedIp).includes(':');
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < retries; i++) {
    try {
      const addrs = v6 ? await dns.resolve6(name) : await dns.resolve4(name);
      if (addrs.includes(expectedIp)) return true;
    } catch { /* NXDOMAIN / not propagated yet */ }
    if (i < retries - 1) await wait(delayMs);
  }
  return false;
}

// --- encrypted token storage (secrets table, mirroring the MRR credentials) ---

/** Store the DuckDNS token encrypted (upsert). */
function storeToken(conn, dataDir, token) {
  const s = createSecrets(dataDir);
  const now = Math.floor(Date.now() / 1000);
  conn.prepare(
    `INSERT INTO secrets (name, blob, updated_at) VALUES ('duckdns_token', ?, ?)
       ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  ).run(s.encrypt('duckdns_token', String(token)), now);
}

/** The stored DuckDNS token, or null if unset/undecryptable. */
function readToken(conn, dataDir) {
  const row = conn.prepare("SELECT blob FROM secrets WHERE name = 'duckdns_token'").get();
  if (!row) return null;
  try { return createSecrets(dataDir).decrypt('duckdns_token', row.blob); } catch { return null; }
}

/** Forget the token (on disable). */
function clearToken(conn) { conn.prepare("DELETE FROM secrets WHERE name = 'duckdns_token'").run(); }

// --- orchestration (DB + MRR) ---

/** Active rentals whose MRR pool we own (not parked on Ocean by dead-rig fallback). */
function ownPoolRentals(conn) {
  return conn.prepare("SELECT r.mrr_id, r.worker_name FROM rentals r JOIN sessions s ON s.id = r.session_id WHERE s.state IN ('active','winding_down') AND r.ended = 0 AND r.rerouted_ocean = 0").all();
}

/**
 * Register the DuckDNS name for the active raw-IP endpoint, VERIFY it resolves to that IP, then adopt
 * it as the endpoint host. Only mutates state on success — a failure leaves the raw IP untouched
 * (setup is never blocked). Repoints live rentals' pools to the name (LIVE) so they gain refund
 * protection. Returns { ok, name } or { ok:false, error }.
 */
async function applyName(conn, dataDir, client, { subdomain, token, runMode, updateFn = update, verifyFn = verifyResolves } = {}) {
  const sub = normalizeSubdomain(subdomain);
  if (!validSubdomain(sub)) return { ok: false, error: 'invalid_subdomain' };
  if (!token) return { ok: false, error: 'token_required' };
  const ep = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!ep) return { ok: false, error: 'no_endpoint' };
  if (!(net.isIP(ep.host) > 0)) return { ok: false, error: 'endpoint_not_ip' };
  const ip = ep.host;
  const upd = await updateFn(sub, token, ip);
  if (!upd.ok) return { ok: false, error: 'duckdns_rejected', detail: upd.response };   // bad token/domain
  if (!(await verifyFn(sub, ip))) return { ok: false, error: 'not_resolving' };   // never adopt a name that doesn't point where we expect
  const name = fqdn(sub);
  // Adopt the name atomically: token + config + endpoint host must flip together, or a crash between
  // them leaves an inconsistent state (config says enabled+name while the endpoint host is still the
  // raw IP, so rentals wouldn't get the name). No await inside the transaction (the network calls ran
  // above); the best-effort MRR repoint below is outside it.
  conn.exec('BEGIN');
  try {
    storeToken(conn, dataDir, token);
    config.set(conn, 'duckdns', { enabled: true, subdomain: sub, ip, updated_at: Math.floor(Date.now() / 1000) });
    conn.prepare('UPDATE pool_endpoints SET host = ? WHERE id = ?').run(name, ep.id);
    conn.exec('COMMIT');
  } catch (e) { try { conn.exec('ROLLBACK'); } catch { /* no active txn */ } throw e; }
  let repointed = 0;
  if (runMode === 'live' && client) {
    for (const r of ownPoolRentals(conn)) {
      try { await client.put(`/rental/${r.mrr_id}/pool/0`, { host: name, port: ep.port, user: r.worker_name, pass: 'x', priority: 0 }); repointed++; } catch { /* best-effort */ }
    }
  }
  return { ok: true, name, repointed };
}

/**
 * Turn the integration OFF (config + token + any fired alert). Does NOT touch the endpoint host — a
 * caller reverts that only when appropriate. The alert-resolve matters because the tick loop's refresh
 * step (the only other resolver) is gated on duckdns.enabled and stops the moment it's disabled, so a
 * fired duckdns_update_failed would otherwise latch forever. Shared by removeName and the endpoint-
 * change auto-disable in the pool-test route.
 */
function disableState(conn) {
  config.set(conn, 'duckdns', { enabled: false });
  clearToken(conn);
  conn.prepare("UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE kind = 'duckdns_update_failed' AND state IN ('armed','fired')").run(Math.floor(Date.now() / 1000));
}

/** Turn DuckDNS off and revert the endpoint (and live rentals' pools) to the backing IP. */
async function removeName(conn, dataDir, client, { runMode } = {}) {
  const cfg = config.get(conn, 'duckdns');
  const ip = cfg.ip;
  const ep = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  disableState(conn);
  if (ep && ip) {
    conn.prepare('UPDATE pool_endpoints SET host = ? WHERE id = ?').run(ip, ep.id);
    if (runMode === 'live' && client) {
      for (const r of ownPoolRentals(conn)) {
        try { await client.put(`/rental/${r.mrr_id}/pool/0`, { host: ip, port: ep.port, user: r.worker_name, pass: 'x', priority: 0 }); } catch { /* best-effort */ }
      }
    }
  }
  return { ok: true, reverted_to: ip };
}

/**
 * Tick step: keep the name pointed at the current VPS IP. Updates DuckDNS when HashGG reports a new
 * IP, or on the daily keepalive — the endpoint host (name) never changes, so no MRR pool rewrites.
 * Returns { ran, updated, ipChanged, error } for the loop to log/alert on.
 */
async function maybeRefresh(conn, dataDir, { hashggIp, nowSec, updateFn = update } = {}) {
  const cfg = config.get(conn, 'duckdns');
  if (!cfg.enabled || !cfg.subdomain) return { ran: false, reason: 'disabled' };
  const targetIp = hashggIp || cfg.ip;   // prefer the live probe; fall back to the stored backing IP
  if (!targetIp) return { ran: false, reason: 'no_ip' };
  const ipChanged = targetIp !== cfg.ip;
  const keepaliveDue = !cfg.updated_at || (nowSec - cfg.updated_at) >= KEEPALIVE_SEC;
  if (!ipChanged && !keepaliveDue) return { ran: false, reason: 'fresh' };
  const token = readToken(conn, dataDir);
  if (!token) return { ran: false, reason: 'no_token' };
  const upd = await updateFn(cfg.subdomain, token, targetIp);
  if (upd.ok) {
    config.set(conn, 'duckdns', { ip: targetIp, updated_at: nowSec });
    return { ran: true, updated: true, ip: targetIp, ipChanged };
  }
  return { ran: true, updated: false, error: upd.response, ipChanged };   // ipChanged + !updated == name is now stale
}

module.exports = { normalizeSubdomain, fqdn, validSubdomain, update, verifyResolves, storeToken, readToken, clearToken, disableState, applyName, removeName, maybeRefresh, DOMAIN_SUFFIX };
