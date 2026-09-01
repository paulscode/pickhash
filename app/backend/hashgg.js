'use strict';
/*
 * HashGG discovery (optional integration). Queries HashGG's HTTP API to learn the
 * user's public stratum endpoint. HashGG is never required — this returns
 * { reachable:false } on any problem so the app stays fully usable without it.
 */
const net = require('node:net');
const config = require('./config');
const algos = require('./algos');

async function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse "host:port" (or "stratum+tcp://host:port") into {host, port, isIp}. */
function parseEndpoint(ep) {
  if (!ep) return null;
  const m = String(ep).replace(/^stratum\+tcp:\/\//i, '').match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]), isIp: net.isIP(m[1]) > 0 };
}

/**
 * Probe HashGG at host:port. Returns { reachable, mode, publicEndpoint:{host,port,isIp}, raw }.
 * Tunnel mode is playit or vps; the public endpoint comes from the mode-specific status route.
 */
async function probe(host, port, opts = {}) {
  const timeoutMs = opts.timeoutMs || 2000;
  const out = { reachable: false, mode: null, publicEndpoint: null, raw: null };
  if (!host) return out;
  const base = `http://${host}:${port || 3000}`;

  const mode = await fetchJson(`${base}/api/tunnel/mode`, timeoutMs);
  if (!mode) return out;
  out.reachable = true;
  out.mode = mode.mode;
  out.raw = { mode };

  const statusUrl = mode.mode === 'vps' ? `${base}/api/vps/status` : `${base}/api/status`;
  const status = await fetchJson(statusUrl, timeoutMs);
  if (status) {
    out.raw.status = status;
    out.publicEndpoint = parseEndpoint(status.public_endpoint);
  }
  return out;
}

/*
 * Where a HashGG might be.
 *
 * Two packages can be installed at once: the ordinary HashGG and HashGG Companion,
 * which exposes the separate BLAKE2b Datum Gateway. Which one an endpoint is pulled
 * from decides which chain the rented hashrate ends up mining, so it is a choice
 * rather than a discovery.
 *
 * Both listen on container port 3000. The Companion's Umbrel tile is on 3033, but
 * that is host-facing only; APP_PORT inside its compose is 3000, so 3033 would not
 * answer from here.
 *
 * Addresses come from the environment because they differ per platform
 * (`hashgg.startos` vs `paulscode-hashgg_web_1`) and neither is knowable from here.
 * An unset one simply never resolves, which probe already handles by returning
 * unreachable — HashGG is optional and the app is fully usable without it.
 */
const SOURCES = {
  flagship: {
    key: 'flagship',
    label: 'HashGG',
    hostVar: 'HASHGG_HOST',
    portVar: 'HASHGG_PORT',
  },
  companion: {
    key: 'companion',
    label: 'HashGG Companion',
    hostVar: 'HASHGG_COMPANION_HOST',
    portVar: 'HASHGG_COMPANION_PORT',
  },
};

const SOURCE_KEYS = Object.keys(SOURCES);

function isKnownSource(key) {
  return Object.hasOwn(SOURCES, String(key));
}

/** Where a source currently lives, or null when the platform did not set it. */
function address(key) {
  const src = SOURCES[key];
  if (!src) return null;
  const host = process.env[src.hostVar] || '';
  if (!host) return null;
  return { key, label: src.label, host, port: Number(process.env[src.portVar] || 3000) };
}

/** Probe one source by key. Unset or unreachable both read as unreachable. */
async function probeSource(key, opts = {}) {
  const addr = address(key);
  if (!addr) return { reachable: false, mode: null, publicEndpoint: null, raw: null, source: key, configured: false };
  const out = await probe(addr.host, addr.port, opts);
  return { ...out, source: key, label: addr.label, host: addr.host, port: addr.port, configured: true };
}

/**
 * Probe every source.
 *
 * Both are reported rather than only the selected one, so the user choosing between
 * them can see which are actually there. Either can be installed and then stopped.
 */
async function probeAll(opts = {}) {
  return Promise.all(SOURCE_KEYS.map((k) => probeSource(k, opts)));
}

/**
 * Which source this algorithm pulls its endpoint from.
 *
 * A stored value naming a source that no longer exists falls back to the algorithm's
 * default rather than probing nothing, so a renamed or removed source degrades to the
 * sensible pairing instead of quietly finding no endpoint at all.
 *
 * Resolution lives here rather than in the API layer because the engine needs the
 * same answer: it probes HashGG every tick and feeds endpoint auto-repair from what
 * it finds, so probing the wrong one would re-point a live endpoint at a pool on the
 * other chain.
 */
function sourceFor(conn) {
  const want = config.getKey(conn, 'strategy', 'hashgg_source');
  if (isKnownSource(want)) return want;
  const active = require('./market').activeAlgo(conn);
  return algos.defaultsFor(active, 'strategy').hashgg_source || config.DEFAULTS.strategy.hashgg_source;
}

module.exports = { probe, parseEndpoint, sourceFor, SOURCES, SOURCE_KEYS, isKnownSource, address, probeSource, probeAll };
