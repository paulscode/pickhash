'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const bootstrap = require('../bootstrap');

// A controllable MRR client that records calls and maintains pool/profile state.
function stubClient() {
  const state = { pools: [], profiles: [] };
  const calls = [];
  return {
    calls,
    state,
    async get(p) {
      calls.push(['GET', p]);
      if (p === '/account/pool') return state.pools;
      if (p === '/account/profile') return state.profiles;
      return {};
    },
    async put(p, params) {
      calls.push(['PUT', p]);
      if (p === '/account/pool') { const id = 'POOL1'; state.pools.push({ id, name: params.name }); return { id }; }
      if (p === '/account/profile') { const id = 'PROF1'; state.profiles.push({ id, name: params.name, pools: [] }); return { id }; }
      const m = p.match(/^\/account\/profile\/([^/]+)\/(\d)$/);
      if (m) {
        const prof = state.profiles.find((x) => String(x.id) === m[1]);
        if (prof) prof.pools = [{ priority: m[2], poolid: params.poolid }];
        return { id: m[1], success: true, message: 'Updated' };
      }
      return {};
    },
  };
}

function puts(client) { return client.calls.filter((c) => c[0] === 'PUT').length; }

test('bootstrap creates pool+profile+attach, records the audit trail, then is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-boot-'));
  try {
    db.open(dir);
    const conn = db.get();
    conn.prepare('INSERT INTO pool_endpoints (id, host, port, worker_base, active) VALUES (1, ?, ?, ?, 1)')
      .run('host.example', 26596, 'bc1qaddr.phash');
    const ep = conn.prepare('SELECT * FROM pool_endpoints WHERE id = 1').get();
    const client = stubClient();

    // First run: three mutations (pool, profile, attach).
    const r1 = await bootstrap.ensure(conn, client, ep);
    assert.equal(r1.mutated, true);
    assert.equal(puts(client), 3);
    // Saved pool used the endpoint host/port and full worker-base username.
    assert.equal(client.state.pools[0].name, 'pickhash:host.example:26596');
    // ids recorded on the endpoint + decisions logged.
    const row = conn.prepare('SELECT mrr_pool_id, mrr_profile_id FROM pool_endpoints WHERE id = 1').get();
    assert.equal(row.mrr_pool_id, r1.poolId);
    assert.equal(row.mrr_profile_id, r1.profileId);
    assert.ok(conn.prepare('SELECT COUNT(*) AS n FROM decisions').get().n >= 3);

    // Second run: everything already in place -> zero mutations.
    client.calls.length = 0;
    const r2 = await bootstrap.ensure(conn, client, ep);
    assert.equal(r2.mutated, false);
    assert.equal(puts(client), 0, 'idempotent: no writes on the second run');
    assert.equal(r2.poolId, r1.poolId);
    assert.equal(r2.profileId, r1.profileId);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
