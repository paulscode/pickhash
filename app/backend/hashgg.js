'use strict';
/*
 * HashGG discovery (optional integration). Queries HashGG's HTTP API to learn the
 * user's public stratum endpoint. HashGG is never required — this returns
 * { reachable:false } on any problem so the app stays fully usable without it.
 */
const net = require('node:net');

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

module.exports = { probe, parseEndpoint };
