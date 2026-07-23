'use strict';
/*
 * Small CLI to exercise the MiningRigRentals client against the live API.
 *
 *   node scripts/mrr-cli.js <METHOD> <ENDPOINT> [key=value ...]
 *
 * Examples:
 *   node scripts/mrr-cli.js GET /whoami
 *   node scripts/mrr-cli.js GET /rig type=sha256ab count=5 islive=yes
 *
 * Credentials come from MRR_KEY / MRR_SECRET (auto-loaded from a .env at the repo
 * root if present). The nonce is persisted in the data-dir database, like the app.
 * Prints the response plus the outcome/path/nonce/latency — never the key or secret.
 */
const path = require('path');
const db = require('../app/backend/db');
const { MrrClient, dbNonceStore } = require('../app/backend/mrr-client');

try { process.loadEnvFile(path.join(process.cwd(), '.env')); } catch { /* no .env — use the real environment */ }

const [method, endpoint, ...rest] = process.argv.slice(2);
if (!method || !endpoint) {
  console.error('usage: node scripts/mrr-cli.js <METHOD> <ENDPOINT> [key=value ...]');
  process.exit(2);
}
if (!process.env.MRR_KEY || !process.env.MRR_SECRET) {
  console.error('MRR_KEY / MRR_SECRET not set (put them in .env at the repo root)');
  process.exit(2);
}

const params = {};
for (const arg of rest) {
  const i = arg.indexOf('=');
  if (i !== -1) params[arg.slice(0, i)] = arg.slice(i + 1);
}

(async () => {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  db.open(dataDir);
  let last = {};
  const client = new MrrClient({
    key: process.env.MRR_KEY,
    secret: process.env.MRR_SECRET,
    nonceStore: dbNonceStore(db.get()),
    log: (e) => { last = e; },
  });
  try {
    const data = await client.call(method.toUpperCase(), endpoint, params);
    console.log(JSON.stringify(data, null, 2));
    console.error(`\n[${last.outcome}] ${method.toUpperCase()} ${last.path}  nonce=${last.nonce}  ${last.latency}ms`);
  } catch (err) {
    console.error(`\nERROR ${err.name}: ${err.message}`);
    if (last.nonce) console.error(`[${last.outcome}] nonce=${last.nonce} ${last.latency}ms`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
