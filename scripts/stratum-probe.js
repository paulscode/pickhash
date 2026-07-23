'use strict';
/*
 * Stratum endpoint probe (diagnostic). Connects, negotiates AsicBoost version-
 * rolling, subscribes, authorizes, and logs the timing of every response and the
 * first work (mining.notify). Helps explain why an external pool compatibility
 * test might time out on an endpoint that real miners use fine.
 *
 *   node scripts/stratum-probe.js <host> <port> <user> [pass] [seconds]
 */
const net = require('node:net');

const [host, portStr, user, pass = 'x', secsStr = '15'] = process.argv.slice(2);
if (!host || !portStr || !user) {
  console.error('usage: stratum-probe <host> <port> <user> [pass] [seconds]');
  process.exit(2);
}
const port = Number(portStr);
const secs = Number(secsStr);

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(3)}s`;

const skipConfigure = process.argv.includes('--no-configure');

const sock = net.connect(port, host, () => {
  console.log(`[${el()}] TCP connected to ${host}:${port}${skipConfigure ? ' (no version-rolling)' : ''}`);
  if (!skipConfigure) send(0, 'mining.configure', [['version-rolling'], { 'version-rolling.mask': '1fffe000' }]);
  send(1, 'mining.subscribe', ['pickhash-probe/1.0']);
  send(2, 'mining.authorize', [user, pass]);
});

function send(id, method, params) {
  sock.write(`${JSON.stringify({ id, method, params })}\n`);
  console.log(`[${el()}] > ${method}`);
}

let buf = '';
sock.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { console.log(`[${el()}] < (raw) ${line}`); continue; }
    const tag = obj.method ? obj.method
      : (obj.result !== undefined ? `result(id=${obj.id})` : `msg(id=${obj.id})`);
    const extra = obj.error ? ` ERROR ${JSON.stringify(obj.error)}` : '';
    console.log(`[${el()}] < ${tag}${extra}`);
  }
});

sock.on('error', (e) => console.log(`[${el()}] socket error: ${e.message}`));
sock.setTimeout(secs * 1000, () => { console.log(`[${el()}] stopping after ${secs}s`); sock.destroy(); });
sock.on('close', () => { console.log(`[${el()}] closed`); process.exit(0); });
