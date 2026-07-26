'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const duckdns = require('../duckdns');
const config = require('../config');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-duckdns-'));
before(() => db.open(DATA));
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => { const c = db.get(); for (const t of ['pool_endpoints', 'rentals', 'sessions', 'config', 'secrets', 'alerts']) c.prepare(`DELETE FROM ${t}`).run(); });

const seedIpEndpoint = (host = '203.0.113.9') => db.get().prepare("INSERT INTO pool_endpoints (name,source,host,port,worker_base,active) VALUES ('e','manual',?,3333,'bc1q.wk',1)").run(host);

// ---- pure helpers ----
test('normalizeSubdomain strips .duckdns.org / URLs and lowercases', () => {
  assert.equal(duckdns.normalizeSubdomain('MyRig'), 'myrig');
  assert.equal(duckdns.normalizeSubdomain('myrig.duckdns.org'), 'myrig');
  assert.equal(duckdns.normalizeSubdomain('https://MyRig.duckdns.org/'), 'myrig');
  assert.equal(duckdns.fqdn('MyRig'), 'myrig.duckdns.org');
});

test('validSubdomain accepts labels and rejects junk', () => {
  assert.equal(duckdns.validSubdomain('my-rig1'), true);
  assert.equal(duckdns.validSubdomain('bad_name'), false);   // underscore not a DNS label char
  assert.equal(duckdns.validSubdomain('-lead'), false);
  assert.equal(duckdns.validSubdomain(''), false);
});

test('update sends ip= for v4 / ipv6= for v6 and parses OK vs KO', async () => {
  const calls = [];
  const okFetch = async (url) => { calls.push(url); return { ok: true, text: async () => 'OK' }; };
  const r4 = await duckdns.update('myrig', 'tok', '1.2.3.4', { fetchImpl: okFetch });
  assert.equal(r4.ok, true);
  assert.match(calls[0], /domains=myrig/);
  assert.match(calls[0], /[?&]ip=1.2.3.4/);
  await duckdns.update('myrig', 'tok', '2001:db8::1', { fetchImpl: okFetch });
  assert.match(calls[1], /ipv6=2001/);
  const koFetch = async () => ({ ok: true, text: async () => 'KO' });
  assert.equal((await duckdns.update('myrig', 'bad', '1.2.3.4', { fetchImpl: koFetch })).ok, false);
});

// ---- encrypted token store ----
test('storeToken/readToken/clearToken round-trips, stored encrypted', () => {
  const c = db.get();
  duckdns.storeToken(c, DATA, 'super-secret-token');
  assert.equal(duckdns.readToken(c, DATA), 'super-secret-token');
  const blob = c.prepare("SELECT blob FROM secrets WHERE name='duckdns_token'").get().blob;
  assert.ok(!Buffer.from(blob).toString('latin1').includes('super-secret-token'), 'token is not stored in plaintext');
  duckdns.clearToken(c);
  assert.equal(duckdns.readToken(c, DATA), null);
});

// ---- applyName (register -> verify -> switch) ----
test('applyName registers, verifies, and adopts the name as the endpoint host', async () => {
  const c = db.get();
  seedIpEndpoint();
  const r = await duckdns.applyName(c, DATA, null, { subdomain: 'MyRig', token: 'tok', runMode: 'dry-run',
    updateFn: async () => ({ ok: true, response: 'OK' }), verifyFn: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'myrig.duckdns.org');
  assert.equal(c.prepare('SELECT host FROM pool_endpoints WHERE active=1').get().host, 'myrig.duckdns.org');
  const cfg = config.get(c, 'duckdns');
  assert.equal(cfg.enabled, true); assert.equal(cfg.subdomain, 'myrig'); assert.equal(cfg.ip, '203.0.113.9');
  assert.equal(duckdns.readToken(c, DATA), 'tok');
});

test('applyName leaves the raw IP untouched when the name does not resolve (setup not blocked)', async () => {
  const c = db.get();
  seedIpEndpoint();
  const r = await duckdns.applyName(c, DATA, null, { subdomain: 'myrig', token: 'tok',
    updateFn: async () => ({ ok: true, response: 'OK' }), verifyFn: async () => false });
  assert.equal(r.error, 'not_resolving');
  assert.equal(c.prepare('SELECT host FROM pool_endpoints WHERE active=1').get().host, '203.0.113.9', 'endpoint stays on the working IP');
  assert.equal(config.get(c, 'duckdns').enabled, false);
  assert.equal(duckdns.readToken(c, DATA), null, 'no token persisted on failure');
});

test('applyName reports duckdns_rejected on a KO response and refuses a non-IP endpoint', async () => {
  const c = db.get();
  seedIpEndpoint();
  assert.equal((await duckdns.applyName(c, DATA, null, { subdomain: 'myrig', token: 'bad', updateFn: async () => ({ ok: false, response: 'KO' }), verifyFn: async () => true })).error, 'duckdns_rejected');
  c.prepare('DELETE FROM pool_endpoints').run();
  seedIpEndpoint('node.example.com');
  assert.equal((await duckdns.applyName(c, DATA, null, { subdomain: 'myrig', token: 'tok', updateFn: async () => ({ ok: true }), verifyFn: async () => true })).error, 'endpoint_not_ip');
});

test('removeName reverts the endpoint to the backing IP and clears the token', async () => {
  const c = db.get();
  seedIpEndpoint('myrig.duckdns.org');
  config.set(c, 'duckdns', { enabled: true, subdomain: 'myrig', ip: '203.0.113.9' });
  duckdns.storeToken(c, DATA, 'tok');
  const r = await duckdns.removeName(c, DATA, null, { runMode: 'dry-run' });
  assert.equal(r.reverted_to, '203.0.113.9');
  assert.equal(c.prepare('SELECT host FROM pool_endpoints WHERE active=1').get().host, '203.0.113.9');
  assert.equal(config.get(c, 'duckdns').enabled, false);
  assert.equal(duckdns.readToken(c, DATA), null);
});

test('removeName resolves a fired duckdns_update_failed alert (no latch after disable)', async () => {
  const c = db.get();
  seedIpEndpoint('myrig.duckdns.org');
  config.set(c, 'duckdns', { enabled: true, subdomain: 'myrig', ip: '203.0.113.9' });
  c.prepare("INSERT INTO alerts (kind,key,severity,state,armed_at,fired_at) VALUES ('duckdns_update_failed','duckdns','warning','fired',1,1)").run();
  await duckdns.removeName(c, DATA, null, { runMode: 'dry-run' });
  assert.equal(c.prepare("SELECT state FROM alerts WHERE kind='duckdns_update_failed'").get().state, 'resolved');
});

// ---- maybeRefresh (IP-change + keepalive) ----
test('maybeRefresh pushes on IP change, no-ops when fresh, re-pushes on the daily keepalive', async () => {
  const c = db.get();
  config.set(c, 'duckdns', { enabled: true, subdomain: 'myrig', ip: '203.0.113.9', updated_at: 1000 });
  duckdns.storeToken(c, DATA, 'tok');
  let pushed = null;
  const upd = async (_sub, _tok, ip) => { pushed = ip; return { ok: true, response: 'OK' }; };
  const r1 = await duckdns.maybeRefresh(c, DATA, { hashggIp: '198.51.100.7', nowSec: 1500, updateFn: upd });
  assert.equal(r1.updated, true); assert.equal(pushed, '198.51.100.7');
  assert.equal(config.get(c, 'duckdns').ip, '198.51.100.7', 'new IP persisted');
  pushed = null;
  const r2 = await duckdns.maybeRefresh(c, DATA, { hashggIp: '198.51.100.7', nowSec: 1600, updateFn: upd });
  assert.equal(r2.ran, false); assert.equal(pushed, null, 'unchanged + within keepalive -> no push');
  const r3 = await duckdns.maybeRefresh(c, DATA, { hashggIp: '198.51.100.7', nowSec: 1600 + 25 * 3600, updateFn: upd });
  assert.equal(r3.updated, true, 'keepalive re-push after 24h even when unchanged');
});

test('maybeRefresh is a no-op when DuckDNS is disabled', async () => {
  const r = await duckdns.maybeRefresh(db.get(), DATA, { hashggIp: '1.2.3.4', nowSec: 1 });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'disabled');
});
