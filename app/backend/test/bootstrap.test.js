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

test('bootstrap brings a saved pool under an old payout address in line, on the same host:port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-boot-'));
  try {
    db.open(dir);
    const conn = db.get();
    conn.prepare('INSERT INTO pool_endpoints (id, host, port, worker_base, active) VALUES (1, ?, ?, ?, 1)')
      .run('host.example', 26596, 'bc1qnewaddr');
    const ep = conn.prepare('SELECT * FROM pool_endpoints WHERE id = 1').get();
    const client = stubClient();
    // Already provisioned under the address the user just moved away from.
    client.state.pools.push({ id: 'POOL1', name: 'pickhash:host.example:26596', user: 'bc1qoldaddr' });
    client.state.profiles.push({ id: 'PROF1', name: 'pickhash:host.example:26596', pools: [{ priority: '0', poolid: 'POOL1' }] });
    const basePut = client.put.bind(client);
    const sent = [];
    client.put = async (p, params) => {
      sent.push([p, params]);
      const m = p.match(/^\/account\/pool\/([^/]+)$/);
      if (m) { const pool = client.state.pools.find((x) => x.id === m[1]); pool.user = params.user; return { id: m[1], success: true }; }
      return basePut(p, params);
    };

    const r1 = await bootstrap.ensure(conn, client, ep);
    assert.equal(r1.mutated, true);
    assert.deepEqual(sent.map((s) => s[0]), ['/account/pool/POOL1'], 'updates the pool in place, creates nothing');
    assert.equal(sent[0][1].user, 'bc1qnewaddr');
    assert.equal(sent[0][1].host, 'host.example');
    assert.ok(conn.prepare('SELECT note FROM decisions').all().some((d) => d.note.startsWith('update saved pool') && d.note.endsWith('bc1qoldaddr -> bc1qnewaddr')));

    sent.length = 0;
    const r2 = await bootstrap.ensure(conn, client, ep);
    assert.equal(r2.mutated, false);
    assert.equal(sent.length, 0, 'idempotent once the username matches');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
