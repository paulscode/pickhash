'use strict';
/**
 * HTTP entrypoint: serves the static dashboard and the JSON API, and (as the app
 * grows) hosts the control loop. One process, one SQLite writer.
 *
 * Health endpoints are split so the platform can distinguish "process is up" from
 * "ready to serve": /livez is always 200 while the process lives; /ready is 200
 * only once the database is open and migrated.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const api = require('./api');

const MAX_BODY_BYTES = 64 * 1024;   // JSON request bodies are small; cap to resist abuse

const PORT = parseInt(process.env.PORT || '3030', 10);
const DATA_DIR = process.env.DATA_DIR || '/root/data';
const FRONTEND_DIR = process.env.FRONTEND_DIR || '/usr/local/lib/pickhash/frontend';

let ready = false;

// Content-Security-Policy. Scripts are locked to same-origin (the vendored libs are
// SRI-pinned and the Alpine build needs no eval), so there is no 'unsafe-inline' or
// 'unsafe-eval' for scripts. 'unsafe-inline' is allowed for styles only (the base
// stylesheet is inlined and has no script capability). The only network egress the
// browser needs is same-origin API calls.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, full) {
  fs.readFile(full, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'not_found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

/**
 * Serve a file from the frontend directory, guarding against directory traversal.
 * Unknown paths with no file extension are treated as client-side routes and fall
 * back to the SPA shell (index.html), so e.g. /styleguide loads the app.
 */
function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(FRONTEND_DIR, rel);
  if (!full.startsWith(FRONTEND_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      if (!path.extname(rel)) { serveFile(res, path.join(FRONTEND_DIR, 'index.html')); return; }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

/** Read and JSON-parse a request body, capped in size. Resolves {} for an empty body. */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];
  setSecurityHeaders(res);

  // Liveness: process is up. Deliberately touches no dependency.
  if (urlPath === '/livez') { sendJson(res, 200, { ok: true }); return; }

  // Readiness: database open and migrations applied.
  if (urlPath === '/ready') {
    sendJson(res, ready ? 200 : 503, { ready });
    return;
  }

  // JSON API.
  if (urlPath.startsWith('/api/')) {
    try {
      const url = new URL(req.url, 'http://pickhash.local');
      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // A request carrying a body must declare application/json. A cross-site form/fetch can only
        // send "simple" content types (text/plain, form-encoded) without a CORS preflight the server
        // never grants, so this blocks form-based CSRF even in the no-password configuration (where
        // the session-CSRF token check is inactive). Empty-body POSTs carry no payload, so allow them.
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
        if (hasBody && !ct.startsWith('application/json')) { sendJson(res, 415, { error: 'unsupported_media_type' }); return; }
        body = await parseBody(req);
      }
      await api.handleApi(req, res, url, body, { dataDir: DATA_DIR });
    } catch (err) {
      if (res.headersSent) return;
      const bad = err && (err.message === 'invalid_json' || err.message === 'body_too_large');
      sendJson(res, bad ? 400 : 500, { error: bad ? err.message : 'internal_error' });
    }
    return;
  }

  // Everything else is the static single-page UI.
  serveStatic(req, res);
}

// Drop from root to the non-root runtime account before touching the data dir, so the DB, the
// encryption key, and any code path run without root. No-op (and safe) when already non-root or
// when the target ids aren't configured; failure logs and continues rather than crash-looping.
function dropPrivileges() {
  if (!(process.getuid && process.getuid() === 0)) return;   // already non-root — nothing to do
  // Running as root is only ever a transient bootstrap state (the entrypoint takes ownership of the
  // volume as root, then hands off). For money-handling software a FAILED drop must fail closed, so
  // we never silently serve as root. An operator who genuinely wants root can set ALLOW_ROOT=1.
  const fail = (msg) => {
    if (process.env.ALLOW_ROOT === '1') { console.error(`[pickhash] ${msg}; ALLOW_ROOT=1 set, continuing as root`); return; }
    console.error(`[pickhash] refusing to run as root: ${msg}. Set PICKHASH_UID/GID (or ALLOW_ROOT=1 to override).`);
    process.exit(1);
  };
  const uid = Number(process.env.PICKHASH_UID);
  const gid = Number(process.env.PICKHASH_GID);
  if (!(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0)) return fail('PICKHASH_UID/GID not set to a non-root id');
  try {
    if (process.setgroups) process.setgroups([gid]);   // drop root's supplementary groups first
    process.setgid(gid);
    process.setuid(uid);   // uid last — after this we can no longer change gid/groups
    console.log(`[pickhash] dropped privileges to uid ${uid}`);
  } catch (e) {
    return fail(`could not drop privileges (${e && e.message})`);
  }
}

function start() {
  dropPrivileges();
  db.open(DATA_DIR);
  // When the platform manages the dashboard password (StartOS Configure screen),
  // apply it before serving so the login gate is active from the first request.
  try { require('./auth').applyManagedPassword(db.get()); }
  catch (e) { console.error('[pickhash] managed password apply failed:', e && e.message); }
  ready = true;

  const server = http.createServer(handleRequest);
  // Explicit timeouts (tighter than Node's defaults) to bound slow-trickle clients. Headers must
  // arrive quickly; the whole request is generously capped because some handlers make outbound
  // calls (endpoint probe, MRR), but a stalled connection can't be held open indefinitely.
  server.headersTimeout = 20 * 1000;
  server.requestTimeout = 120 * 1000;
  server.keepAliveTimeout = 10 * 1000;
  server.listen(PORT, () => console.log(`[pickhash] listening on :${PORT}`));

  // Control loop: observe -> alerts -> lifecycle every 60s. No-ops cleanly until MRR
  // creds are stored; never blocks the HTTP server.
  // Engine events (errors + per-tick spend-cycle outcomes) go to stdout as JSON lines so an
  // unattended run has a durable, greppable trace alongside the DB tables — otherwise the
  // engine's log callback defaults to a no-op and a thrown tick would leave no record.
  const engineLog = (e) => {
    try { console.log(`[engine] ${JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...e })}`); }
    catch { /* logging must never break the loop */ }
  };
  let engine = null;
  try { engine = require('./engine/runner').startEngine(db.get(), DATA_DIR, { log: engineLog }); }
  catch (e) { console.error('[pickhash] engine failed to start:', e && e.message); }

  // Clean shutdown: stop accepting connections, checkpoint + close the DB, exit.
  // The container entrypoint forwards SIGTERM here.
  const shutdown = () => {
    if (engine) { try { engine.stop(); } catch { /* best effort */ } }
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => { db.close(); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) start();

module.exports = { handleRequest, start };
