'use strict';
/*
 * Forgiving stratum-endpoint parsing. Accepts whatever the user pastes into the host
 * field — bare host, host:port, or a full stratum+tcp:// URL, with or without a
 * separate port — and returns a clean { host, port }. A port embedded in the host
 * string wins over the separate port field (a pasted full endpoint is authoritative).
 */

function parse(hostRaw, portRaw) {
  let host = String(hostRaw == null ? '' : hostRaw).trim();
  let port = portRaw != null && String(portRaw).trim() !== '' ? Number(portRaw) : null;

  // Strip a scheme like stratum+tcp:// , stratum+ssl:// , tcp:// .
  host = host.replace(/^\w+(\+\w+)?:\/\//i, '');
  // Strip any trailing path/query (e.g. a copied "host:port/").
  host = host.replace(/[/?#].*$/, '').trim();

  // IPv6 in brackets: [::1] or [::1]:port
  const v6 = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
    return { host, port };
  }

  // host:port (a single colon and a numeric port — not a bare IPv6 address).
  const hp = host.match(/^([^:]+):(\d+)$/);
  if (hp) { host = hp[1]; port = Number(hp[2]); }

  return { host, port };
}

const net = require('node:net');
const dns = require('node:dns').promises;

// Reconstruct a dotted-quad from two 16-bit hextets (the low 32 bits of an embedded-v4 IPv6 form).
function hextetsToV4(a, b) {
  const n = ((parseInt(a, 16) & 0xffff) * 0x10000) + (parseInt(b, 16) & 0xffff);
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

// If an IPv6 string embeds an IPv4 address (in any of the wrappings the kernel will actually route
// to IPv4), return the canonical dotted-quad so the v4 rules can't be dodged by notation: ::ffff:
// mapped (dotted OR hex), ::x v4-compat, 64:ff9b:: NAT64, 2002:: 6to4. Else null.
function embeddedV4(s) {
  let m;
  if ((m = s.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/))) return m[1];
  if ((m = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/))) return hextetsToV4(m[1], m[2]);
  if ((m = s.match(/^64:ff9b::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/))) return m[1];
  if ((m = s.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/))) return hextetsToV4(m[1], m[2]);
  if ((m = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})::?/))) return hextetsToV4(m[1], m[2]);
  return null;
}

/**
 * IPs that are never a valid stratum target and are dangerous for the server to probe: link-local
 * (which includes the 169.254.169.254 cloud-metadata service and its embedded-v4 IPv6 forms), the
 * AWS IPv6 metadata ULA (fd00:ec2::/32), IPv6 link-local, multicast, 0.0.0.0/8, and the unspecified
 * address. Loopback and RFC1918/ULA are intentionally ALLOWED — a local HashGG / Datum / LAN miner
 * endpoint is the ordinary case. Callers pass a resolved IP and connect to that literal, so this
 * plus IP-pinning stops a pasted host or a rebinding DNS name from probing internal/metadata hosts.
 */
function isBlockedIp(ip) {
  let s = String(ip == null ? '' : ip).trim().toLowerCase().replace(/%.*$/, '');   // drop any zone id
  const v4 = embeddedV4(s);
  if (v4) s = v4;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const o = s.split('.').map(Number);
    if (o.some((n) => !(n >= 0 && n <= 255))) return true;   // malformed -> refuse
    if (o[0] === 0) return true;                             // 0.0.0.0/8 (incl. unspecified)
    if (o[0] === 169 && o[1] === 254) return true;           // link-local + cloud metadata
    if (o[0] >= 224) return true;                            // multicast / reserved
    return false;                                            // loopback + RFC1918 allowed
  }
  if (s === '::' || s === '::0') return true;                // IPv6 unspecified
  if (/^fe[89ab]/.test(s)) return true;                      // fe80::/10 link-local
  if (/^ff/.test(s)) return true;                            // ff00::/8 multicast
  if (/^fd00:ec2:/.test(s)) return true;                     // AWS IMDS over IPv6 (ULA)
  return false;
}

/**
 * Resolve `host` to a single validated IP to connect to, or null if it doesn't resolve or ANY
 * resolved address is blocked. Callers must connect to the returned literal IP (never the hostname)
 * so a DNS name can't rebind to an internal address between validation and connect. Run on EVERY
 * outbound stratum probe (setup AND the recurring engine health probe).
 */
async function resolvePinnedIp(host) {
  const h = String(host == null ? '' : host).trim();
  if (!h) return null;
  if (net.isIP(h)) return isBlockedIp(h) ? null : h;   // literal IP -> validate directly
  let addrs;
  try { addrs = await dns.lookup(h, { all: true }); } catch { return null; }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) return null;
  return addrs[0].address;
}

module.exports = { parse, isBlockedIp, resolvePinnedIp };
