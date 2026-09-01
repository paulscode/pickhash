'use strict';
/*
 * Per-rig share difficulty, carried in the Stratum password.
 *
 * MRR scores a rental on the hashrate it measures from accepted shares. A rig left at
 * a difficulty far above its own size produces too few shares to measure well, so a
 * rental that really did deliver reads as underdelivering and the refund claim gets
 * declined. Fixing that means putting each rig at its own difficulty, and the password
 * is the only field a rental passes to the pool verbatim (the standard mechanism,
 * mining.configure's minimum-difficulty extension, is sent by the miner, and these are
 * third-party rigs whose firmware we do not control).
 *
 * Two properties matter most here and are asserted directly: the difficulty must
 * actually reach the wire on pool/0, and it must survive the paths that later rewrite
 * pool/0 on a live rental. Rewriting the password back to 'x' mid-rental would undo the
 * whole thing silently, which is the failure this feature exists to avoid.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stratumDiff = require('../diff');
const quote = require('../quote');
const session = require('../session');
const duckdns = require('../duckdns');
const endpointRepair = require('../engine/endpoint-repair');
const db = require('../db');
const config = require('../config');

// Awaits the body before closing: these cases are async, and a synchronous finally
// would shut the database while the call under test was still using it.
async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-sdiff-'));
  db.open(dir);
  try { return await fn(db.get(), dir); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A client that records what was sent rather than sending it. */
function recordingClient() {
  const puts = [];
  return {
    puts,
    async put(p, body) { puts.push([p, body]); return /\/rental$/.test(p) ? { id: 9001 } : { ok: true }; },
    async get() { return {}; },
  };
}

const ENDPOINT = { host: 'ab.example.gg', port: 26596, worker_base: 'bc1qabc.phash', mrr_profile_id: 953073 };

/** One active session with one live rental holding the given password. */
function seedLiveRental(conn, stratumPass) {
  conn.prepare("INSERT INTO sessions (id, mode, state) VALUES (1, 'autopilot', 'active')").run();
  conn.prepare(
    "INSERT INTO rentals (session_id, mrr_id, rig_id, worker_name, health, ended, rerouted_ocean, stratum_pass) VALUES (1, 555, 42, 'bc1qabc.phash-r555', 'healthy', 0, 0, ?)",
  ).run(stratumPass);
}

// A rig as market.normalizeRig produces it, trimmed to what these paths read.
function rig(over = {}) {
  return {
    id: '1', name: 'r', region: 'us-east', rpi: 100,
    advertisedTh: 2.3, hourBtc: 0.001, priceBtcThDay: 0.01,
    measuredTh: { m5: 2.3, m15: 2.3, m30: 2.3 },
    minHours: 1, maxHours: 24,
    optimalDiff: { min: 5355, max: 32131 },
    online: true, status: 'available', rented: false, available: true,
    priceEnabled: true, poolstatus: 'online',
    ...over,
  };
}

test('the chosen difficulty is a power of two inside the rig\'s own optimal range', () => {
  // Real values read from the live market on 2026-09-01. Vardiff steps by halving and
  // doubling and the gateway rounds a request DOWN to a power of two, so rounding down
  // here would land below optimal_diff.min: these all round UP and stay in range.
  const cases = [
    [{ min: 1164, max: 6985 }, 2048],       // SLONGDONG-HS500, 0.50 TH
    [{ min: 1281, max: 7683 }, 2048],       // Amostwanted, 0.55 TH
    [{ min: 4331, max: 25984 }, 8192],      // Skippy-HS3-SE, 1.86 TH
    [{ min: 5355, max: 32131 }, 8192],      // !-SUPER-BOX, 2.30 TH
    [{ min: 6752, max: 40513 }, 8192],      // Goldshell 2,9T, 2.90 TH
    [{ min: 10245, max: 61467 }, 16384],    // SC Lite (5B80), 4.40 TH
    [{ min: 27940, max: 167638 }, 32768],   // SC 12 B, 12.00 TH
  ];
  for (const [optimalDiff, want] of cases) {
    const got = stratumDiff.chooseDiff(rig({ optimalDiff }));
    assert.equal(got, want, `${optimalDiff.min}-${optimalDiff.max}`);
    assert.ok(got >= optimalDiff.min && got <= optimalDiff.max, 'inside the range MRR published');
    assert.equal(got & (got - 1), 0, 'a power of two');
  }
});

test('a rig that publishes nothing usable is left to the pool rather than guessed at', () => {
  assert.equal(stratumDiff.chooseDiff(rig({ optimalDiff: null })), null);
  assert.equal(stratumDiff.chooseDiff(rig({ optimalDiff: { min: null, max: null } })), null);
  assert.equal(stratumDiff.chooseDiff(rig({ optimalDiff: { min: 0, max: 100 } })), null);
  assert.equal(stratumDiff.chooseDiff(rig({ optimalDiff: { min: 'abc', max: 'def' } })), null);
  // A band narrower than a factor of two can contain no power of two at all.
  assert.equal(stratumDiff.chooseDiff(rig({ optimalDiff: { min: 1100, max: 1500 } })), null);
  // and one that does is still used.
  assert.equal(stratumDiff.chooseDiff(rig({ optimalDiff: { min: 1000, max: 1500 } })), 1024);
});

test('no request is expressed as the filler every miner already sends', () => {
  // 'x' is what this sent before the feature existed. A pool that does not understand a
  // request must be no worse off than it was, and DATUM discards an unrecognised
  // password rather than erroring on it.
  assert.equal(stratumDiff.password(null), 'x');
  assert.equal(stratumDiff.password(0), 'x');
  assert.equal(stratumDiff.password(NaN), 'x');
  assert.equal(stratumDiff.password(undefined), 'x');
  assert.equal(stratumDiff.password(8192), 'd=8192');
  assert.equal(stratumDiff.passwordForRig(rig()), 'd=8192');
  assert.equal(stratumDiff.passwordForRig(rig({ optimalDiff: null })), 'x');
});

test('the support probe asks for MORE than the endpoint offered, never less', () => {
  // Every floor in the gateway clamps a request upward, so a raise cannot be refused
  // for being out of bounds. Probing downward could be clamped and read as "ignored",
  // turning a supported endpoint into an unsupported one.
  for (const observed of [64, 1024, 16384, 100]) {
    const p = stratumDiff.probeDiff(observed);
    assert.ok(p > observed, `${p} > ${observed}`);
    assert.equal(p & (p - 1), 0, 'a power of two');
  }
  assert.equal(stratumDiff.probeDiff(null), null);
  assert.equal(stratumDiff.probeDiff(0), null);
  assert.equal(stratumDiff.probeDiff(2 ** 47), null, 'no request beyond the sane ceiling');
});

test('a rig is only given its own difficulty when the endpoint was proven to honour one', () => {
  // Detected, not assumed. A stock gateway discards the password, so recording a
  // per-rig difficulty against one would put a number in the telemetry that never
  // reached the miner.
  const off = quote.derive(rig(), { endpointDiff: 64 });
  assert.equal(off.chosenDiff, null);
  assert.equal(off.diffInRange, false, 'judged against the endpoint default of 64, which is below the range');

  const on = quote.derive(rig(), { endpointDiff: 64, supportsPasswordDiff: true });
  assert.equal(on.chosenDiff, 8192);
  assert.equal(on.diffInRange, true, 'judged against what it will actually run at');
});

test('an endpoint that honours requests does not make an unusable rig look usable', () => {
  // chooseDiff returns null for a rig with no published range even when the endpoint
  // supports requests, and the endpoint default applies as before.
  const r = quote.derive(rig({ optimalDiff: null }), { endpointDiff: 64, supportsPasswordDiff: true });
  assert.equal(r.chosenDiff, null);
  assert.equal(r.diffInRange, null, 'unknown, not true');
});

test('strict diff matching judges the rig by the difficulty it will actually run at', () => {
  // strictDiff is off by default (optimal_diff is advisory), but when an operator turns
  // it on, a rig we are about to place inside its own optimal range must not then be
  // rejected for being outside the endpoint's default.
  const base = { endpointDiff: 64, strictDiff: true, allowUnproven: true };
  const without = quote.eligibility(quote.derive(rig(), base), base);
  assert.ok(without.reasons.includes('diff_mismatch'), 'endpoint default 64 is outside 5355-32131');

  const withSupport = { ...base, supportsPasswordDiff: true };
  const on = quote.eligibility(quote.derive(rig(), withSupport), withSupport);
  assert.ok(!on.reasons.includes('diff_mismatch'), 'we are placing it at 8192, which is inside');
});

test('the difficulty reaches the wire on pool/0, and the fallback pool is left alone', async () => {
  const client = recordingClient();
  const intent = {
    rigId: 42, lengthHours: 3, advertisedTh: 2.3, priceUnit: 'th', rateCapUnitDay: 0.001,
    stratumPass: 'd=8192',
  };
  const res = await session.rentOne(client, intent, ENDPOINT, {
    fallbackPool: { host: 'ocean.example', port: 3334 },
  });

  const primary = client.puts.find((c) => /\/pool\/0$/.test(c[0]));
  assert.equal(primary[1].pass, 'd=8192', 'the request actually goes out');
  assert.equal(res.stratumPass, 'd=8192', 'and is reported back for persistence');

  // The fallback is a third-party pool, engaged only once our endpoint has already
  // dropped, and MRR measures the rental on pool 0. Nothing to gain, and a stranger's
  // pool is the wrong place to try an unrecognised password.
  const fallback = client.puts.find((c) => /\/pool\/1$/.test(c[0]));
  assert.equal(fallback[1].pass, 'x');
});

test('an intent from before this existed still sends a valid password, not "undefined"', async () => {
  // A quote stored by an older build has no stratumPass on its rigs. The password field
  // is a string on the wire; sending the word "undefined" would be a silent behaviour
  // change on every rental replayed from a stored quote.
  const client = recordingClient();
  await session.rentOne(client, { rigId: 42, lengthHours: 3, priceUnit: 'th', rateCapUnitDay: 0.001 }, ENDPOINT, {});
  assert.equal(client.puts.find((c) => /\/pool\/0$/.test(c[0]))[1].pass, 'x');
});

test('a rental keeps its difficulty when DuckDNS repoints it mid-rental', async () => {
  // applyName rewrites pool/0 on every live rental to move it onto the name. Writing
  // 'x' back there would undo the difficulty silently, on a rental already paid for.
  await withDb(async (conn, dir) => {
    conn.prepare("INSERT INTO pool_endpoints (name,source,host,port,worker_base,active) VALUES ('e','manual','203.0.113.9',3333,'bc1qabc.phash',1)").run();
    seedLiveRental(conn, 'd=8192');
    const client = recordingClient();
    const r = await duckdns.applyName(conn, dir, client, {
      subdomain: 'myrig', token: 'tok', runMode: 'live',
      updateFn: async () => ({ ok: true, response: 'OK' }), verifyFn: async () => true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.repointed, 1);
    const repoint = client.puts.find((c) => /\/pool\/0$/.test(c[0]));
    assert.equal(repoint[1].host, 'myrig.duckdns.org', 'it did move the rental');
    assert.equal(repoint[1].pass, 'd=8192', 'and kept the difficulty while doing it');
  });
});

test('a rental keeps its difficulty when DuckDNS is turned off and it reverts to the IP', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare("INSERT INTO pool_endpoints (name,source,host,port,worker_base,active) VALUES ('e','manual','myrig.duckdns.org',3333,'bc1qabc.phash',1)").run();
    config.set(conn, 'duckdns', { enabled: true, subdomain: 'myrig', ip: '203.0.113.9' });
    seedLiveRental(conn, 'd=2048');
    const client = recordingClient();
    await duckdns.removeName(conn, dir, client, { runMode: 'live' });
    const repoint = client.puts.find((c) => /\/pool\/0$/.test(c[0]));
    assert.equal(repoint[1].host, '203.0.113.9');
    assert.equal(repoint[1].pass, 'd=2048');
  });
});

test('a rental adopted before this existed repoints as "x" rather than "null"', async () => {
  // stratum_pass is NULL on every row that predates the migration, and on rentals
  // adopted from MRR's own record. That has to read as the old behaviour.
  await withDb(async (conn, dir) => {
    conn.prepare("INSERT INTO pool_endpoints (name,source,host,port,worker_base,active) VALUES ('e','manual','203.0.113.9',3333,'bc1qabc.phash',1)").run();
    seedLiveRental(conn, null);
    const client = recordingClient();
    await duckdns.applyName(conn, dir, client, {
      subdomain: 'myrig', token: 'tok', runMode: 'live',
      updateFn: async () => ({ ok: true, response: 'OK' }), verifyFn: async () => true,
    });
    assert.equal(client.puts.find((c) => /\/pool\/0$/.test(c[0]))[1].pass, 'x');
  });
});

test('a rental keeps its difficulty when endpoint repair moves it to a new host', async () => {
  // Endpoint repair rewrites pool/0 on every live rental when HashGG reports the
  // gateway has moved. Same hazard as the DuckDNS paths, different trigger.
  await withDb(async (conn) => {
    conn.prepare("INSERT INTO pool_endpoints (name,source,host,port,worker_base,active) VALUES ('e','manual','203.0.113.9',3333,'bc1qabc.phash',1)").run();
    seedLiveRental(conn, 'd=16384');
    const client = recordingClient();
    const plan = { from: { host: '203.0.113.9', port: 3333 }, to: { host: '127.0.0.1', port: 4444 } };
    const r = await endpointRepair.repair(conn, client, { plan, runMode: 'live', now: 1 });
    assert.ok(!r.blocked, 'the loopback target resolves and is allowed');
    const repoint = client.puts.find((c) => /\/pool\/0$/.test(c[0]));
    assert.equal(repoint[1].host, '127.0.0.1', 'it did move the rental');
    assert.equal(repoint[1].pass, 'd=16384', 'and kept the difficulty while doing it');
  });
});
