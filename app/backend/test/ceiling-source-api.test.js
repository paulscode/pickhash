'use strict';
/*
 * The Autopilot preview API with a ceiling feed set (issue #16): the feed's ceiling holds, and a
 * ceiling in the request cannot loosen it.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-ceilapi-'));
process.env.DATA_DIR = DATA;

const server = require('../server');
const db = require('../db');
const config = require('../config');
const mrr = require('../mrr');
const cs = require('../ceiling-source');
const { createMockServer } = require('../../../scripts/mrr-mock');

let appServer; let appPort; let mockServer;
function listen(s) { return new Promise((r) => s.listen(0, () => r(s.address().port))); }
function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: appPort, path: p }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }));
    }).on('error', reject);
  });
}

before(async () => {
  db.open(DATA);
  mockServer = createMockServer({});
  process.env.MRR_BASE_URL = `http://127.0.0.1:${await listen(mockServer)}`;
  process.env.ALLOW_INSECURE_MRR = '1';
  mrr._resetClient();
  mrr.storeCreds(db.get(), DATA, 'k'.repeat(32), 's'.repeat(32));
  db.get().prepare("INSERT INTO pool_endpoints (host, port, worker_base, stratum_diff, mrr_pool_id, mrr_profile_id, active) VALUES ('ab.gg', 26596, 'bc1qx.w', 131072, 111, 953073, 1)").run();
  config.set(db.get(), 'setup', { completed: true });
  appServer = http.createServer(server.handleRequest);
  appPort = await listen(appServer);
});
after(async () => {
  delete process.env.MRR_BASE_URL; delete process.env.ALLOW_INSECURE_MRR;
  mockServer.closeAllConnections?.();
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
  mrr._resetClient(); cs._reset();
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('with a feed set, the preview is held to it and a requested ceiling cannot loosen it', async () => {
  const now = Math.floor(Date.now() / 1000);
  config.set(db.get(), 'guardrails', { ceiling_source_url: 'http://10.0.0.5/c.json' });
  const reply = { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ blended_ceiling_sats_unit_day: 5000, as_of: now }) };
  await cs.refresh(db.get(), { nowSec: now, fetchImpl: async () => reply });
  const r = await get('/api/autopilot/estimate?target_th=300&budget_sats=1000000&blended_ceiling_sats_unit_day=99999');
  assert.equal(r.status, 200);
  assert.equal(r.json.current_blended_ceiling_sats_unit_day, 5000);
  assert.equal(r.json.estimate.ceilingSatsUnitDay, 5000, 'held to the feed, not the request');
  assert.equal(r.json.ceiling_source.ok, true);
  // Without the feed the requested ceiling applies, as before.
  config.set(db.get(), 'guardrails', { ceiling_source_url: null });
  const r2 = await get('/api/autopilot/estimate?target_th=300&budget_sats=1000000&blended_ceiling_sats_unit_day=99999');
  assert.equal(r2.json.estimate.ceilingSatsUnitDay, 99999);
  assert.equal(r2.json.ceiling_source, null);
});
