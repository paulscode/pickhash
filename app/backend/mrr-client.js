'use strict';
/*
 * Client for the MiningRigRentals v2 API.
 *
 * This client can spend real Bitcoin, so it guarantees a few safety properties:
 *
 *   - One request in flight at a time. Every call goes through a single promise
 *     queue, because the API's per-key nonce must strictly increase; parallel
 *     requests would race it and get rejected.
 *   - The nonce is persisted BEFORE a request is sent and only ever moves forward
 *     (max of last-persisted+1 and the current millisecond clock), so a crash or
 *     restart can never reuse or go backwards.
 *   - Reads (GET) retry transient failures with backoff. Mutations (any other
 *     method) are NEVER retried on an ambiguous failure (timeout / 5xx / network):
 *     we cannot tell whether the rental was actually created, and a blind retry
 *     could rent twice. The caller reconciles by observing state instead.
 *   - The key, secret, and signature are never logged.
 *
 * Signing: x-api-sign = HMAC-SHA1(secret, key + nonce + path), hex. The signed
 * "path" is the endpoint only — no query string, no trailing slash, no /api/v2
 * prefix (e.g. "/rig/14"). Params go in a JSON body for writes, or the query
 * string for GET (the signature ignores the query either way).
 */
const crypto = require('node:crypto');

const BASE_URL = 'https://www.miningrigrentals.com/api/v2';
const DEFAULT_THROTTLE_MS = 750;   // polite minimum spacing between calls (limits are unpublished)
const READ_MAX_ATTEMPTS = 3;

class MrrError extends Error {
  constructor(message, info) { super(message); this.name = 'MrrError'; this.info = info || {}; }
}
// Server rejected the nonce (request was NOT processed).
class MrrNonceError extends MrrError { constructor(m, i) { super(m, i); this.name = 'MrrNonceError'; } }
// Auth/permission/signature failure — the engine should suspend and alert, not hammer.
class MrrAuthError extends MrrError { constructor(m, i) { super(m, i); this.name = 'MrrAuthError'; } }
// success:false for some other reason.
class MrrApiError extends MrrError { constructor(m, i) { super(m, i); this.name = 'MrrApiError'; } }
// HTTP-level failure on a read after retries.
class MrrHttpError extends MrrError { constructor(m, i) { super(m, i); this.name = 'MrrHttpError'; } }
// A MUTATION failed with an UNKNOWN outcome (timeout / 5xx / network). Never retry —
// reconcile by observing state on the next tick.
class MrrAmbiguousError extends MrrError { constructor(m, i) { super(m, i); this.name = 'MrrAmbiguousError'; } }

/** HMAC-SHA1(secret, key + nonce + path) as hex. */
function sign(secret, key, nonce, path) {
  return crypto.createHmac('sha1', secret).update(String(key) + String(nonce) + String(path)).digest('hex');
}

/** The signable path: endpoint with query string and any trailing slash stripped. */
function signablePath(endpoint) {
  let p = endpoint.split('?')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Flatten a params object to dotted keys and build a URL query string. */
function toQuery(params) {
  const pairs = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  };
  walk(params || {}, '');
  return pairs.join('&');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MrrClient {
  /**
   * @param {object} opts
   * @param {string} opts.key
   * @param {string} opts.secret
   * @param {{read():number, write(n:number):void}} opts.nonceStore  persisted nonce
   * @param {function} [opts.fetch]   fetch implementation (injectable for tests)
   * @param {function} [opts.log]     receives {path, method, outcome, latency, nonce} — never secrets
   * @param {number}   [opts.throttleMs]
   * @param {number}   [opts.timeoutMs]
   * @param {number}   [opts.backoffBaseMs]
   */
  constructor(opts) {
    this.key = opts.key;
    this.secret = opts.secret;
    this.nonceStore = opts.nonceStore;
    this.baseUrl = opts.baseUrl || BASE_URL;   // overridable for the mock server in tests
    this.fetchImpl = opts.fetch || globalThis.fetch;
    this.log = opts.log || (() => {});
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 300;
    this.queue = Promise.resolve();
    this.lastCallAt = 0;
  }

  /** Next nonce: strictly increasing, persisted before use. */
  nextNonce() {
    const last = this.nonceStore.read() || 0;
    const n = Math.max(last + 1, Date.now());
    this.nonceStore.write(n);
    return n;
  }

  /** Enqueue a call on the single serialized chain. Resolves to the response `data`. */
  call(method, endpoint, params = {}) {
    const run = () => this._throttleThen(() => this._call(method, endpoint, params));
    const result = this.queue.then(run, run);
    this.queue = result.then(() => {}, () => {});   // keep the chain alive past rejections
    return result;
  }

  get(endpoint, params) { return this.call('GET', endpoint, params); }
  put(endpoint, params) { return this.call('PUT', endpoint, params); }
  post(endpoint, params) { return this.call('POST', endpoint, params); }
  del(endpoint, params) { return this.call('DELETE', endpoint, params); }

  async _throttleThen(fn) {
    const wait = this.throttleMs - (Date.now() - this.lastCallAt);
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
    return fn();
  }

  async _call(method, endpoint, params) {
    const isRead = method === 'GET';
    const path = signablePath(endpoint);
    let attempt = 0;
    let nonceRetried = false;

    while (true) {
      attempt++;
      const nonce = this.nextNonce();
      const started = Date.now();

      let status, bodyText;
      try {
        ({ status, bodyText } = await this._fetch(method, endpoint, params, nonce, path));
      } catch (err) {
        // Network failure / timeout / abort — covers both the request and the body read.
        const latency = Date.now() - started;
        this.log({ path, method, outcome: 'network_error', latency, nonce });
        if (isRead && attempt < READ_MAX_ATTEMPTS) { await sleep(this._backoff(attempt)); continue; }
        if (!isRead) throw new MrrAmbiguousError(`network failure on ${method} ${path}`, { cause: String((err && err.message) || err) });
        throw new MrrHttpError(`network failure on ${method} ${path}`, { cause: String((err && err.message) || err) });
      }

      const latency = Date.now() - started;
      let json;
      try { json = bodyText ? JSON.parse(bodyText) : {}; } catch { json = null; }

      // Transient HTTP: retry reads with backoff; a mutation is ambiguous (never retried).
      if (status === 429 || status >= 500) {
        this.log({ path, method, outcome: `http_${status}`, latency, nonce });
        if (isRead && attempt < READ_MAX_ATTEMPTS) { await sleep(this._backoff(attempt)); continue; }
        if (!isRead) throw new MrrAmbiguousError(`${method} ${path} returned HTTP ${status}`, { status });
        throw new MrrHttpError(`${method} ${path} returned HTTP ${status}`, { status });
      }

      // Explicit API error envelope ({success:false, data:{message}}).
      if (json && json.success === false) {
        const msg = (json.data && json.data.message) || 'request failed';
        const lower = String(msg).toLowerCase();
        this.log({ path, method, outcome: 'api_error', latency, nonce });
        if (lower.includes('nonce')) {
          // Rejected, not processed. Resync forward — never below what we've already
          // issued (a same-ms burst can push the nonce above the wall clock).
          this.nonceStore.write(Math.max(this.nonceStore.read(), Date.now()));
          if (isRead && !nonceRetried) { nonceRetried = true; continue; }
          throw new MrrNonceError(msg, { status });
        }
        if (/unauthor|forbidden|permission|signature|denied|not allowed|api[ _-]?key|invalid key|access/.test(lower)) throw new MrrAuthError(msg, { status });
        throw new MrrApiError(msg, { status, data: json.data });
      }

      // Any other non-2xx is a definitive rejection (request NOT processed — e.g. a
      // 4xx from a proxy/WAF with a non-JSON body). Surface it; never return null-as-ok.
      if (status < 200 || status >= 300) {
        this.log({ path, method, outcome: `http_${status}`, latency, nonce });
        if (status === 401 || status === 403) throw new MrrAuthError(`${method} ${path} returned HTTP ${status}`, { status });
        throw new MrrApiError(`${method} ${path} returned HTTP ${status}`, { status });
      }

      // A 2xx with a non-empty body we couldn't parse (json === null): don't treat it
      // as a successful null. For a mutation the outcome is unknown (it may have applied)
      // → ambiguous, reconcile by observing. For a read, surface an error.
      if (json === null) {
        this.log({ path, method, outcome: 'unparseable', latency, nonce });
        if (!isRead) throw new MrrAmbiguousError(`${method} ${path}: unparseable response`, { status });
        throw new MrrHttpError(`${method} ${path}: unparseable response`, { status });
      }

      this.log({ path, method, outcome: 'ok', latency, nonce });
      return json && typeof json === 'object' && 'data' in json ? json.data : json;
    }
  }

  /** One HTTP attempt. The abort timer covers BOTH the request and the body read, so a
   *  server that sends headers then stalls the body can't hang the serialized queue. */
  async _fetch(method, endpoint, params, nonce, path) {
    const headers = {
      'x-api-key': this.key,
      'x-api-nonce': String(nonce),
      'x-api-sign': sign(this.secret, this.key, nonce, path),
      'content-type': 'application/json',
    };
    let url = this.baseUrl + endpoint;
    let body;
    if (method === 'GET') {
      const qs = toQuery(params);
      if (qs) url += (endpoint.includes('?') ? '&' : '?') + qs;
    } else {
      body = JSON.stringify(params || {});
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method, headers, body, signal: ac.signal });
      const bodyText = await res.text();   // still under the abort timer
      return { status: res.status, bodyText };
    } finally {
      clearTimeout(timer);
    }
  }

  _backoff(attempt) {
    return this.backoffBaseMs * Math.pow(2, attempt - 1);
  }
}

/** Nonce store backed by the mrr_nonce table (single row id=1). */
function dbNonceStore(conn) {
  conn.prepare('INSERT OR IGNORE INTO mrr_nonce (id, nonce) VALUES (1, 0)').run();
  return {
    read() { const r = conn.prepare('SELECT nonce FROM mrr_nonce WHERE id = 1').get(); return r ? r.nonce : 0; },
    write(n) { conn.prepare('UPDATE mrr_nonce SET nonce = ? WHERE id = 1').run(n); },
  };
}

/** In-memory nonce store (tests, ephemeral use). */
function memoryNonceStore(initial = 0) {
  let n = initial;
  return { read: () => n, write: (v) => { n = v; } };
}

module.exports = {
  MrrClient, dbNonceStore, memoryNonceStore, sign, signablePath, toQuery,
  MrrError, MrrNonceError, MrrAuthError, MrrApiError, MrrHttpError, MrrAmbiguousError,
};
