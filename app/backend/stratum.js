'use strict';
/*
 * Programmatic stratum endpoint probe. Connects the way an AsicBoost rig would —
 * negotiate version-rolling, subscribe, authorize, wait for the first work — and
 * returns a structured report. Never throws.
 *
 * This is Pickhash's AUTHORITATIVE endpoint validator. The rental marketplace's own
 * pool test false-negatives on Datum/HashGG endpoints (it times out where a real rig
 * gets work in under half a second), so we validate with a rig-like handshake instead
 * and also capture the negotiated difficulty for the rig-search difficulty match.
 */
const net = require('node:net');

function probe(host, port, user, opts = {}) {
  const pass = opts.pass || 'x';
  const timeoutMs = opts.timeoutMs || 12000;
  const t0 = Date.now();
  const el = () => Date.now() - t0;

  return new Promise((resolve) => {
    const result = {
      reachable: false, subscribed: false, authorized: false, gotWork: false,
      difficulty: null, msToSubscribe: null, msToFirstWork: null, error: null,
    };
    // net.connect throws SYNCHRONOUSLY on a bad port (ERR_SOCKET_BAD_PORT), which would
    // reject this promise and break the "never throws" contract the tick relies on. Validate
    // first and resolve a normal failure report instead.
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      result.error = 'bad_port';
      resolve(result);
      return;
    }
    let settled = false;
    let hardDeadline = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (hardDeadline) clearTimeout(hardDeadline);
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    const sock = net.connect({ host, port: portNum }, () => {
      result.reachable = true;
      send(0, 'mining.configure', [['version-rolling'], { 'version-rolling.mask': '1fffe000' }]);
      send(1, 'mining.subscribe', ['pickhash-probe/1.0']);
      send(2, 'mining.authorize', [user, pass]);
    });
    // Idle timer AND a hard wall-clock deadline: the idle timer alone can be kept alive
    // forever by a host that trickles bytes without ever sending work.
    sock.setTimeout(timeoutMs, () => { if (!result.error) result.error = 'timeout'; finish(); });
    hardDeadline = setTimeout(() => { if (!result.error) result.error = 'timeout'; finish(); }, timeoutMs);
    if (hardDeadline.unref) hardDeadline.unref();

    function send(id, method, params) {
      try { sock.write(`${JSON.stringify({ id, method, params })}\n`); } catch { /* socket closing */ }
    }

    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result !== undefined && m.error == null) { result.subscribed = true; result.msToSubscribe = el(); }
        if (m.id === 2 && m.result === true) result.authorized = true;
        if (m.method === 'mining.set_difficulty' && Array.isArray(m.params)) result.difficulty = Number(m.params[0]);
        if (m.method === 'mining.notify') { result.gotWork = true; result.msToFirstWork = el(); finish(); }
      }
    });
    sock.on('error', (e) => { if (!result.error) result.error = e.message; finish(); });
    sock.on('close', () => finish());
  });
}

module.exports = { probe };
