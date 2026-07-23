'use strict';
/*
 * Dashboard authentication: an optional password (scrypt), server-side sessions with
 * a per-session CSRF token, and a GLOBAL, PERSISTED login lockout.
 *
 * Design notes (see the security model):
 *   - Sessions live in an in-process map (single process, zero deps); they're lost on
 *     restart, which just means re-login. The CSRF token is bound to the session.
 *   - The failed-login lockout is GLOBAL, not per-IP: behind a reverse proxy or Tor
 *     the source IP is constant, so a per-IP limit would be useless or lock everyone
 *     out. It's persisted (config) so a restart can't reset it.
 *   - Password verification is constant-time (secrets.verifyPassword).
 */
const crypto = require('node:crypto');
const config = require('./config');
const { hashPassword, verifyPassword } = require('./secrets');

const SESSION_COOKIE = 'pickhash_session';
const SESSION_TTL_SEC = 12 * 3600;
const MAX_BACKOFF_SEC = 15 * 60;

// sessionId -> { csrf, createdAt }
const sessions = new Map();

function now() { return Math.floor(Date.now() / 1000); }
function passwordEnabled(conn) { return !!conn.prepare('SELECT 1 FROM secrets WHERE name = ?').get('dashboard_password'); }

function setPassword(conn, password) {
  const blob = hashPassword(password);
  conn.prepare(
    `INSERT INTO secrets (name, blob, updated_at) VALUES ('dashboard_password', ?, ?)
       ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  ).run(blob, now());
}

function lockState(conn) {
  const a = config.get(conn, 'auth');
  return { failCount: a.fail_count || 0, lockedUntil: a.locked_until || 0 };
}

/** Verify a supplied password against the stored hash (constant-time). No lockout side effects. */
function verifyCurrent(conn, password) {
  const stored = conn.prepare("SELECT blob FROM secrets WHERE name = 'dashboard_password'").get();
  return !!stored && verifyPassword(password, stored.blob);
}

/** True when the platform manages the dashboard password (StartOS passes it as env). */
function isManaged() { return !!process.env.DASHBOARD_PASSWORD; }

/**
 * When the platform manages the dashboard password (StartOS surfaces it on the
 * Configure/Properties screen and passes it as DASHBOARD_PASSWORD), make that value
 * the source of truth: set it on first boot and re-apply whenever the platform value
 * changes. Idempotent — if the stored hash already verifies the env password, nothing
 * is written (so the salt/hash and any in-flight sessions are left untouched). Returns
 * true when a password is externally managed.
 */
function applyManagedPassword(conn) {
  const managed = process.env.DASHBOARD_PASSWORD;
  if (!managed) return false;
  if (!verifyCurrent(conn, managed)) {
    setPassword(conn, managed);
    // A CHANGED platform-managed password is an owner action, so clear any login lockout: a
    // locked-out owner recovers simply by setting a new password on the platform's config screen.
    // Only fires when the value actually changed (a crash/restart re-applies the same password and
    // matches here, so an attacker can't clear the lockout by forcing a restart).
    config.set(conn, 'auth', { fail_count: 0, locked_until: 0 });
  }
  return true;
}

function sweepExpired() {
  const cutoff = now() - SESSION_TTL_SEC;
  for (const [id, s] of sessions) if (s.createdAt < cutoff) sessions.delete(id);
}

function createSession() {
  sweepExpired();                                          // bound the in-memory map
  const id = crypto.randomBytes(16).toString('hex');       // 128-bit session id
  const csrf = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { csrf, createdAt: now() });
  return { id, csrf };
}

/**
 * Verify the dashboard password under the SHARED, persisted global lockout: refuses while locked,
 * records each failure with exponential backoff (from the 3rd), and resets the counter on success.
 * Both the login and the change-password "current password" check go through this, so neither path
 * can be brute-forced without engaging the same lockout. Does NOT create a session.
 * Returns {ok:true} or {ok:false, reason:'locked'|'bad_password', retryAfter}.
 */
function guardedVerify(conn, password) {
  const { failCount, lockedUntil } = lockState(conn);
  const t = now();
  if (t < lockedUntil) return { ok: false, reason: 'locked', retryAfter: lockedUntil - t };

  const stored = conn.prepare("SELECT blob FROM secrets WHERE name = 'dashboard_password'").get();
  const good = !!stored && verifyPassword(password, stored.blob);
  if (!good) {
    const next = failCount + 1;
    const backoff = next >= 3 ? Math.min(2 ** (next - 2), MAX_BACKOFF_SEC) : 0;
    config.set(conn, 'auth', { fail_count: next, locked_until: backoff ? t + backoff : 0 });
    return { ok: false, reason: 'bad_password', retryAfter: backoff };
  }
  config.set(conn, 'auth', { fail_count: 0, locked_until: 0 });
  return { ok: true };
}

/** Attempt a login. Returns {ok, id, csrf} or {ok:false, reason, retryAfter}. */
function login(conn, password) {
  const r = guardedVerify(conn, password);
  if (!r.ok) return r;
  const s = createSession();   // rotate: fresh session on success
  return { ok: true, id: s.id, csrf: s.csrf };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionFromReq(req) {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (now() - s.createdAt > SESSION_TTL_SEC) { sessions.delete(id); return null; }
  return { id, ...s };
}

function logout(req) {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (id) sessions.delete(id);
}

function cookieHeader(id) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}${secure}`;
}
function clearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function csrfOk(session, req) {
  const header = req.headers['x-csrf-token'];
  if (!session || !header) return false;
  const a = Buffer.from(String(header));
  const b = Buffer.from(String(session.csrf));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Test-only: clear the in-memory session map.
function _reset() { sessions.clear(); }

module.exports = {
  SESSION_COOKIE, passwordEnabled, setPassword, verifyCurrent, guardedVerify, isManaged, applyManagedPassword,
  login, logout, createSession, sessionFromReq, cookieHeader, clearCookieHeader, csrfOk, lockState, _reset,
};
