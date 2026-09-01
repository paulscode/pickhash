'use strict';
/*
 * Which HashGG an endpoint is pulled from.
 *
 * Two can be installed at once: the ordinary HashGG and HashGG Companion, which
 * exposes the separate BLAKE2b Datum Gateway. The endpoint they hand back looks
 * identical either way — a host and a port — so the source is the only thing that
 * distinguishes a working setup from rented hashrate pointed at the wrong chain.
 *
 * Discovery used to read one pair of environment variables and take whatever
 * answered.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const hashgg = require('../hashgg');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-hg-'));
  db.open(dir);
  try { return fn(db.get(), dir); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('each algorithm has its own default source, and blake2b pairs with the Companion', () => {
  withDb((conn) => {
    assert.equal(hashgg.sourceFor(conn), 'flagship');
    config.set(conn, 'algorithm', { active: 'blake2b' });
    assert.equal(hashgg.sourceFor(conn), 'companion');
  });
});

test('the choice is per algorithm, so each remembers its own', () => {
  withDb((conn) => {
    // A user whose ordinary HashGG serves a BLAKE2b gateway, which is possible: the
    // ordinary one follows whatever chain its Datum was built for.
    config.set(conn, 'algorithm', { active: 'blake2b' });
    config.set(conn, 'strategy', { hashgg_source: 'flagship' });
    assert.equal(hashgg.sourceFor(conn), 'flagship');

    config.set(conn, 'algorithm', { active: 'sha256ab' });
    assert.equal(hashgg.sourceFor(conn), 'flagship', 'unaffected');

    config.set(conn, 'strategy', { hashgg_source: 'companion' });
    assert.equal(hashgg.sourceFor(conn), 'companion');
    config.set(conn, 'algorithm', { active: 'blake2b' });
    assert.equal(hashgg.sourceFor(conn), 'flagship', "blake2b's own choice, not sha256ab's");
  });
});

test('a stored source that no longer exists falls back to the algorithm default', () => {
  withDb((conn) => {
    config.set(conn, 'algorithm', { active: 'blake2b' });
    config.set(conn, 'strategy', { hashgg_source: 'hashgg-classic' });
    // Degrading to the sensible pairing beats probing nothing and reporting no
    // endpoint, which looks like HashGG being down.
    assert.equal(hashgg.sourceFor(conn), 'companion');
  });
});

test('the settings schema offers exactly the sources that exist', () => {
  withDb((conn) => {
    const spec = config.settings(conn).strategy.hashgg_source;
    assert.deepEqual(spec.values, hashgg.SOURCE_KEYS);
    assert.equal(spec.type, 'enum');
    // And nothing else is accepted, so a typo cannot store a source that silently
    // resolves to the default forever.
    assert.equal(config.validatePatch('strategy', { hashgg_source: 'nope' }).ok, false);
    assert.equal(config.validatePatch('strategy', { hashgg_source: 'companion' }).ok, true);
  });
});

test('the two sources read different addresses, and the Companion is not the tile port', () => {
  withEnv({
    HASHGG_HOST: 'hashgg.startos', HASHGG_PORT: '3000',
    HASHGG_COMPANION_HOST: 'hashgg-companion.startos', HASHGG_COMPANION_PORT: '3000',
  }, () => {
    const flag = hashgg.address('flagship');
    const comp = hashgg.address('companion');
    assert.equal(flag.host, 'hashgg.startos');
    assert.equal(comp.host, 'hashgg-companion.startos');
    assert.notEqual(flag.host, comp.host, 'two addresses, not one');
    // Both listen on 3000 inside their containers. The Companion's Umbrel tile is on
    // 3033, but that is host-facing only and would not answer from here.
    assert.equal(comp.port, 3000);
  });
});

test('an unset source is not reachable rather than an error', async () => {
  await withEnv({ HASHGG_COMPANION_HOST: undefined }, async () => {
    const r = await hashgg.probeSource('companion');
    assert.equal(r.reachable, false);
    assert.equal(r.configured, false, 'and it says the address was never set, not that it failed');
    assert.equal(r.publicEndpoint, null);
  });
});

test('probeAll reports every source, so a user can see which is actually there', async () => {
  await withEnv({ HASHGG_HOST: undefined, HASHGG_COMPANION_HOST: undefined }, async () => {
    const all = await hashgg.probeAll();
    assert.deepEqual(all.map((c) => c.source).sort(), [...hashgg.SOURCE_KEYS].sort());
    assert.ok(all.every((c) => c.reachable === false));
  });
});
