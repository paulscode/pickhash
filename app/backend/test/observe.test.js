'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const observe = require('../engine/observe');
const health = require('../engine/health');

// ---- Pure reconcile ----

test('reconcile adopts an untracked rental matching a pending intent, exactly once', () => {
  const r = observe.reconcile({
    trackedMrrIds: [9000002],
    mrrList: [
      { id: 9000002, rig: { id: 800002 }, start_unix: 1000 },   // already tracked -> skipped
      { id: 9001, rig: { id: 400 }, start_unix: 2000 },          // untracked, matches intent
    ],
    intents: [{ id: 11, ts: 1990, rig: 400 }],
  });
  assert.deepEqual(r.adopt, [{ mrrId: '9001', intentId: 11, rigId: 400 }]);
  assert.equal(r.unattributable.length, 0);
});

test('reconcile flags an untracked rental with no matching intent as unattributable', () => {
  const r = observe.reconcile({
    trackedMrrIds: [],
    mrrList: [{ id: 9002, rig: { id: 999 }, start_unix: 5000 }],
    intents: [{ id: 1, ts: 100, rig: 400 }],   // wrong rig / wrong window
  });
  assert.equal(r.adopt.length, 0);
  assert.deepEqual(r.unattributable, [{ mrrId: '9002', rigId: 999 }]);
});

test('reconcile never adopts two rentals against one intent', () => {
  const r = observe.reconcile({
    trackedMrrIds: [],
    mrrList: [
      { id: 1, rig: { id: 400 }, start_unix: 1000 },
      { id: 2, rig: { id: 400 }, start_unix: 1001 },
    ],
    intents: [{ id: 7, ts: 990, rig: 400 }],
  });
  assert.equal(r.adopt.length, 1, 'only one adopted');
  assert.equal(r.unattributable.length, 1, 'the second is unattributable, not a re-rent');
});

// ---- mergeRental (pure) ----

test('mergeRental advances health from a fresh detail and detects end', () => {
  const rental = { mrr_id: 1, advertised_th: 200, start_ts: 1000, end_ts: 9_999_999_999 };
  const startMs = 1000 * 1000;
  const prevH = health.initial(startMs);
  const afterRamp = startMs + 16 * 60 * 1000;
  const m = observe.mergeRental(rental, { hashrate: { average: { percent: '97' } } }, prevH, undefined, afterRamp);
  assert.equal(m.health.state, 'healthy');
  assert.equal(m.signal.source, 'mrr');
  assert.ok(Math.abs(m.signal.deliveredTh - 194) < 1e-9);
  // Ended via end_ts in the past.
  const ended = observe.mergeRental({ ...rental, end_ts: 1000 }, null, m.health, 97, afterRamp);
  assert.equal(ended.ended, true);
  assert.equal(ended.health.state, 'ended');
});

// ---- observe() integration ----

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-observe-'));
before(() => {
  db.open(DATA);
  const conn = db.get();
  const now = 1_700_000_000;
  conn.prepare("INSERT INTO sessions (id, mode, state, created_at, started_at) VALUES (1,'quick','active',?,?)").run(now, now);
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, region, advertised_th, length_hours,
                paid_sats, fee_sats, start_ts, end_ts, health, worker_name)
                VALUES (1, 9000002, 800002, 'Example Rig (3)', 'sa-br', 208, 3, 1367, 41, ?, ?, 'pending', 'bc1q.w-r9000002')`)
    .run(now, now + 3 * 3600);
});
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => { db.get().prepare('DELETE FROM rental_samples').run(); });

function mockClient(opts = {}) {
  return {
    async get(p) {
      if (opts.rentalListThrows && p === '/rental') throw new Error('mrr down');
      if (p === '/rental') return { records: [{ id: 9000002, rig: { id: 800002 }, start_unix: 1_700_000_000 }] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '96.5' } }, ended: false };
      if (p === '/account/balance') return { BTC: { confirmed: '0.00047000', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: { last_10: { amount: '0.0006' } } } };
      throw new Error('unexpected ' + p);
    },
  };
}
// Past the 15-min ramp so health can settle.
const NOW_MS = (1_700_000_000 + 20 * 60) * 1000;

test('observe returns a well-shaped snapshot and advances rental health', async () => {
  const { snapshot, nextState } = await observe.observe(db.get(), mockClient(), { now: NOW_MS, marketSkip: true, prevState: { rentals: {}, marketAt: NOW_MS } });
  assert.equal(snapshot.ts, Math.floor(NOW_MS / 1000));
  assert.deepEqual(Object.keys(snapshot.fetch_ok).sort(), ['balance', 'endpoint', 'hashgg', 'market', 'rentals']);
  assert.equal(snapshot.fetch_ok.rentals, true);
  assert.equal(snapshot.rentals.length, 1);
  assert.equal(snapshot.rentals[0].health, 'healthy');       // 96.5% past ramp
  assert.equal(snapshot.rentals[0].source, 'mrr');
  assert.equal(snapshot.balance.confirmed_sats, 47000);
  // A fresh sample was persisted.
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rental_samples').get().n, 1);
  assert.ok(nextState.rentals[9000002]);
});

test('the snapshot carries per-rental paid_sats/fee_sats so the balance_low burn rate is real', async () => {
  const { snapshot } = await observe.observe(db.get(), mockClient(), { now: NOW_MS, marketSkip: true, prevState: { rentals: {}, marketAt: NOW_MS } });
  const r = snapshot.rentals[0];
  // Seed rental #9000002 was billed 1367 + 41. Without these fields burnRateSatsPerHour
  // reads 0 and balance_low can never fire.
  assert.equal(r.paid_sats, 1367);
  assert.equal(r.fee_sats, 41);
});

test('an ended rental has its end_ts refreshed to MRR\'s actual end_unix (dispute/refund window)', async () => {
  const conn = db.get();
  const start = 1_700_000_000;
  const scheduled = start + 3 * 3600;     // create-time scheduled end
  const actual = start + 40 * 60;         // MRR terminated it early
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name)
                VALUES (1, 400, 9, 'EarlyEnd Rig', 100, 3, 1000, 30, ?, ?, 0, 'healthy', 'w')`).run(start, scheduled);
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [{ id: 400, rig: { id: 9 }, start_unix: start }] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '96' } }, ended: false };
      if (p === '/rental/400') return { hashrate: { average: { percent: '97' } }, ended: true, end_unix: actual };
      if (p === '/rental/400/graph') return { chartdata: { offline: 'none', pooloffline: 'none', bars: '' } };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  await observe.observe(conn, client, { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS, refundAt: NOW_MS } });
  assert.equal(conn.prepare('SELECT end_ts FROM rentals WHERE mrr_id = 400').get().end_ts, actual, 'end_ts refreshed to the real end, not the scheduled one');
  conn.prepare('DELETE FROM rentals WHERE mrr_id = 400').run();
});

test('a 0/"" end_unix sentinel does NOT clobber a legitimately-ended rental\'s end_ts', async () => {
  const conn = db.get();
  const start = 1_700_000_000;
  const scheduled = start + 3 * 3600;
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name)
                VALUES (1, 401, 9, 'Sentinel Rig', 100, 3, 1000, 30, ?, ?, 0, 'healthy', 'w')`).run(start, scheduled);
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [{ id: 401, rig: { id: 9 }, start_unix: start }] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '96' } }, ended: false };
      if (p === '/rental/401') return { hashrate: { average: { percent: '80' } }, ended: true, end_unix: 0 };   // sentinel
      if (p === '/rental/401/graph') return { chartdata: { offline: 'none', pooloffline: 'none', bars: '' } };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  await observe.observe(conn, client, { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS, refundAt: NOW_MS } });
  assert.equal(conn.prepare('SELECT end_ts FROM rentals WHERE mrr_id = 401').get().end_ts, scheduled, 'end_ts kept, not clobbered to 0');
  conn.prepare('DELETE FROM rentals WHERE mrr_id = 401').run();
});

test('reconciliation does not flag a KNOWN (even ended / other-session) rental as a stray', async () => {
  const conn = db.get();
  conn.prepare("INSERT INTO sessions (id, mode, state, created_at, started_at) VALUES (77,'quick','ended',1,1)").run();
  conn.prepare("INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name) VALUES (77, 8888, 5, 'Ended', 100, 3, 1000, 30, 1, 2, 1, 'ended', 'w')").run();
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [
        { id: 9000002, rig: { id: 800002 }, start_unix: 1_700_000_000 },   // the active seeded rental (known)
        { id: 8888, rig: { id: 5 }, start_unix: 1_700_000_000 },            // known but ENDED -> must NOT be a stray
        { id: 9999, rig: { id: 400 }, start_unix: 1_700_000_000 },          // genuinely untracked -> stray
      ] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '96' } }, ended: false };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  const { snapshot } = await observe.observe(conn, client, { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS } });
  const strays = snapshot.reconciliation.unattributable.map((s) => s.mrrId);
  assert.ok(!strays.includes('8888'), 'a known ended rental is not a stray');
  assert.ok(strays.includes('9999'), 'a genuinely untracked active rental is flagged');
  conn.prepare('DELETE FROM rentals WHERE mrr_id = 8888').run();
  conn.prepare('DELETE FROM sessions WHERE id = 77').run();
});

test('observe snapshots dispute evidence into evidence_json when a rental ends', async () => {
  const conn = db.get();
  const start = 1_700_000_000;
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name)
                VALUES (1, 200, 5, 'Ending Rig', 100, 3, 1000, 30, ?, ?, 0, 'healthy', 'w')`).run(start, start + 60);
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [{ id: 200, rig: { id: 5 }, start_unix: start }] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '96' } }, ended: false };
      if (p === '/rental/200') return { hashrate: { average: { percent: '91' } }, ended: true, end_unix: start + 60 };
      if (p === '/rental/200/graph') return { chartdata: { offline: 'none', pooloffline: 'none', bars: '' }, hashtype: 'ph', advertised: {} };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  await observe.observe(conn, client, { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS, refundAt: NOW_MS } });
  const ev = JSON.parse(conn.prepare('SELECT evidence_json FROM rentals WHERE mrr_id = 200').get().evidence_json);
  assert.equal(ev.final_percent, 91);
  assert.deepEqual(ev.offline_periods, []);
  assert.equal(ev.captured_at, Math.floor(NOW_MS / 1000));
  conn.prepare('DELETE FROM rentals WHERE mrr_id = 200').run();   // keep other tests isolated
});

test('observe stores market last10/last in per-TH-day (info/algos is per-PH-day)', async () => {
  db.get().prepare('DELETE FROM market_snapshots').run();
  // marketAt:0 forces the 5-min market fetch to run this tick.
  await observe.observe(db.get(), mockClient(), { now: NOW_MS, prevState: { rentals: {}, marketAt: 0 } });
  const snap = db.get().prepare('SELECT last10 FROM market_snapshots ORDER BY ts DESC LIMIT 1').get();
  // The mock's info/algos last_10 amount is '0.0006' (per PH·day) -> stored /1000 per TH·day.
  assert.ok(Math.abs(snap.last10 - 0.0006 / 1000) < 1e-12, `last10 stored per-TH·day, got ${snap.last10}`);
});

test('a rentals-list blip sets fetch_ok:false and HOLDS the previous health', async () => {
  // Seed prev state: rental was healthy.
  const startMs = 1_700_000_000 * 1000;
  const prevH = health.step(health.initial(startMs), { percent: 97, source: 'mrr', fresh: true, now: NOW_MS });
  const prev = { rentals: { 9000002: { health: prevH, percent: 97 } }, marketAt: NOW_MS };
  const { snapshot } = await observe.observe(db.get(), mockClient({ rentalListThrows: true }), { now: NOW_MS, prevState: prev });
  assert.equal(snapshot.fetch_ok.rentals, false);
  assert.equal(snapshot.rentals[0].health, 'healthy', 'previous state held, not lost');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rental_samples').get().n, 0, 'no fresh sample on a blip');
});

test('a per-rental DETAIL blip (list ok) HOLDS delivered_th/percent instead of collapsing to null', async () => {
  // The list fetch succeeds (fetch_ok.rentals stays true -> decide still runs), but this rental's
  // detail blips. Without holding, delivered_th would read null -> a CONFIRMED degraded/offline rig
  // (whose contribution decide measures) would count as 0 and trigger a spurious top-up. Hold the
  // last measured percent and derive delivered_th from it.
  const startMs = 1_700_000_000 * 1000;
  const prev = { rentals: { 9000002: { health: health.initial(startMs), percent: 80 } }, marketAt: NOW_MS };
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [{ id: 9000002, rig: { id: 800002 }, start_unix: 1_700_000_000 }] };
      if (p === '/rental/9000002') throw new Error('detail blip');
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  const { snapshot } = await observe.observe(db.get(), client, { now: NOW_MS, prevState: prev });
  assert.equal(snapshot.fetch_ok.rentals, true, 'only the detail blipped -> decide still runs this tick');
  const r = snapshot.rentals.find((x) => x.mrr_id === 9000002);
  assert.equal(r.fresh, false, 'not a fresh reading');
  assert.equal(r.percent, 80, 'last measured percent held');
  assert.ok(Math.abs(r.delivered_th - 208 * 0.8) < 1e-9, `delivered_th held (208 x 80%), got ${r.delivered_th}`);
});

// A client that serves an empty active-rentals list (so fetch_ok.rentals stays true and the
// dispute-evidence pass runs) plus per-id detail/graph handlers supplied by the caller.
function evidenceClient(handlers = {}) {
  return {
    async get(p) {
      if (p === '/rental') return { records: [] };
      if (handlers[p]) return handlers[p]();
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      // Any other /rental/<id> detail (e.g. the always-tracked seed rental) -> a blip.
      if (p.startsWith('/rental/')) throw new Error('no detail for ' + p);
      throw new Error('unexpected ' + p);
    },
  };
}
const EV_PREV = { rentals: {}, marketAt: NOW_MS, refundAt: NOW_MS, pruneAt: NOW_MS };

test('dispute evidence is captured when the graph fetch fails but detail succeeds (final % locked in)', async () => {
  const conn = db.get();
  const start = 1_700_000_000;
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name)
                VALUES (1, 300, 7, 'GraphGone Rig', 100, 3, 1000, 30, ?, ?, 1, 'ended', 'w')`).run(start, start + 60);
  const client = evidenceClient({
    '/rental/300': () => ({ hashrate: { average: { percent: '80' } }, ended: true, end_unix: start + 60 }),
    '/rental/300/graph': () => { throw new Error('graph pruned'); },
  });
  await observe.observe(conn, client, { now: NOW_MS, prevState: EV_PREV });
  const ev = JSON.parse(conn.prepare('SELECT evidence_json FROM rentals WHERE mrr_id = 300').get().evidence_json);
  assert.equal(ev.final_percent, 80, 'final % locked in from detail even without a graph');
  assert.deepEqual(ev.offline_periods, [], 'no graph -> empty offline periods (still captured, stops retrying)');
  conn.prepare('DELETE FROM rentals WHERE mrr_id = 300').run();
});

test('a detail blip does NOT lock in null evidence; a later tick captures it once detail returns', async () => {
  const conn = db.get();
  const start = 1_700_000_000;
  conn.prepare(`INSERT INTO rentals (session_id, mrr_id, rig_id, rig_name, advertised_th, length_hours, paid_sats, fee_sats, start_ts, end_ts, ended, health, worker_name)
                VALUES (1, 301, 8, 'Blip Rig', 100, 3, 1000, 30, ?, ?, 1, 'ended', 'w')`).run(start, start + 60);
  let detailUp = false;
  const client = evidenceClient({
    '/rental/301': () => { if (!detailUp) throw new Error('detail blip'); return { hashrate: { average: { percent: '70' } }, ended: true, end_unix: start + 60 }; },
    '/rental/301/graph': () => ({ chartdata: { offline: 'none', pooloffline: 'none', bars: '' } }),
  });
  await observe.observe(conn, client, { now: NOW_MS, prevState: EV_PREV });
  assert.equal(conn.prepare('SELECT evidence_json FROM rentals WHERE mrr_id = 301').get().evidence_json, null,
    'a detail blip must not lock in a null-percent evidence bundle');
  detailUp = true;
  await observe.observe(conn, client, { now: NOW_MS, prevState: EV_PREV });
  const ev = JSON.parse(conn.prepare('SELECT evidence_json FROM rentals WHERE mrr_id = 301').get().evidence_json);
  assert.equal(ev.final_percent, 70, 'evidence captured on the retry tick');
  conn.prepare('DELETE FROM rentals WHERE mrr_id = 301').run();
});

test('reconciliation surfaces an intent-matched stray in adopt and an unattributable stray as review', async () => {
  const conn = db.get();
  const intentId = Number(conn.prepare("INSERT INTO decisions (ts, session_id, note, proposed_json) VALUES (?, 1, 'intent', ?)")
    .run(1_700_000_500, JSON.stringify({ rig: 400 })).lastInsertRowid);
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [
        { id: 9000002, rig: { id: 800002 }, start_unix: 1_700_000_000 },  // already tracked -> skipped
        { id: 9500, rig: { id: 400 }, start_unix: 1_700_000_600 },        // matches the intent -> adopt
        { id: 9600, rig: { id: 999 }, start_unix: 1_700_000_600 },        // no intent -> unattributable
      ] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '96' } }, ended: false };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  const { snapshot } = await observe.observe(conn, client, { now: NOW_MS, prevState: EV_PREV });
  assert.deepEqual(snapshot.reconciliation.adopt, [{ mrrId: '9500', intentId, rigId: 400 }]);
  assert.deepEqual(snapshot.reconciliation.unattributable, [{ mrrId: '9600', rigId: 999 }]);
  conn.prepare("DELETE FROM decisions WHERE id = ?").run(intentId);
});

test('reconciliation matches an AUTOPILOT intent (note "autopilot intent"), not only quick-session intents', async () => {
  // Regression: autopilot's top-up writes its intent row with note 'autopilot intent' (execute.js),
  // so a reconcile query that matched only note='intent' would leave every autopilot ambiguous-
  // create orphan UNATTRIBUTABLE and never auto-adopt it — silently disabling recovery for the one
  // path it was built for.
  const conn = db.get();
  const intentId = Number(conn.prepare("INSERT INTO decisions (ts, session_id, note, proposed_json) VALUES (?, 1, 'autopilot intent', ?)")
    .run(1_700_000_500, JSON.stringify({ rig: 401 })).lastInsertRowid);
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [{ id: 9700, rig: { id: 401 }, start_unix: 1_700_000_600 }] };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      throw new Error('unexpected ' + p);
    },
  };
  const { snapshot } = await observe.observe(conn, client, { now: NOW_MS, prevState: EV_PREV });
  assert.deepEqual(snapshot.reconciliation.adopt, [{ mrrId: '9700', intentId, rigId: 401 }], 'the autopilot orphan is matched for adoption');
  assert.equal(snapshot.reconciliation.unattributable.length, 0, 'not left for manual review');
  conn.prepare('DELETE FROM decisions WHERE id = ?').run(intentId);
});

test('daily prune runs once 24h has elapsed (advancing pruneAt) and is skipped otherwise', async () => {
  const conn = db.get();
  const nowSec = Math.floor(NOW_MS / 1000);
  const oldTs = nowSec - 100 * 86400;   // outside the 90-day retention window
  const insertOld = () => conn.prepare('INSERT OR REPLACE INTO rental_samples (rental_id, ts, delivered_th, percent, health) VALUES (9, ?, 1, 1, ?)').run(oldTs, 'x');

  // Skipped: pruneAt is recent (< 24h ago) -> the old row survives, pruneAt unchanged.
  insertOld();
  const skip = await observe.observe(conn, mockClient(), { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS, refundAt: NOW_MS, pruneAt: NOW_MS } });
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM rental_samples WHERE ts = ?').get(oldTs).n, 1, 'old row kept when prune is skipped');
  assert.equal(skip.nextState.pruneAt, NOW_MS, 'pruneAt unchanged when skipped');

  // Runs: pruneAt is 0 (>= 24h ago) -> the old row is pruned, pruneAt advances to now.
  const run = await observe.observe(conn, mockClient(), { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS, refundAt: NOW_MS, pruneAt: 0 } });
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM rental_samples WHERE ts = ?').get(oldTs).n, 0, 'old row pruned when prune runs');
  assert.equal(run.nextState.pruneAt, NOW_MS, 'pruneAt advanced to now');
});

test('a rental ending folds its final delivery into the rig score (observe -> scoring hook)', async () => {
  const conn = db.get();
  conn.prepare('UPDATE rentals SET ended = 0, avg_percent = NULL WHERE mrr_id = 9000002').run();
  conn.prepare('DELETE FROM rig_scores WHERE rig_id = 800002').run();
  const client = {
    async get(p) {
      if (p === '/rental') return { records: [{ id: 9000002, rig: { id: 800002 }, start_unix: 1_700_000_000 }] };
      if (p === '/rental/9000002') return { hashrate: { average: { percent: '80' } }, ended: true, end_unix: 1_700_000_500 };
      if (p === '/account/balance') return { BTC: { confirmed: '0.0004', unconfirmed: '0' } };
      if (p === '/rig') return { records: [], total: 0 };
      if (p.startsWith('/info/algos')) return { stats: { prices: {} } };
      if (p.startsWith('/rental/9000002/graph')) return {};
      throw new Error('unexpected ' + p);
    },
  };
  await observe.observe(conn, client, { now: NOW_MS, prevState: { rentals: {}, marketAt: NOW_MS } });
  const row = conn.prepare('SELECT rentals, mean_percent FROM rig_scores WHERE rig_id = 800002').get();
  assert.ok(row, 'a rig_scores row was created on the rental end');
  assert.equal(row.rentals, 1);
  assert.ok(Math.abs(row.mean_percent - 80) < 1e-6, 'folded the 80% final delivery');
  conn.prepare('UPDATE rentals SET ended = 0 WHERE mrr_id = 9000002').run();
});

test('observe pins the endpoint probe to a validated IP: probes a good one, refuses a blocked one', async () => {
  const net = require('net');
  const conn = db.get();
  const strat = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method === 'mining.subscribe') {
          sock.write(`${JSON.stringify({ id: m.id, result: [[['mining.notify', '1']], 'e', 4], error: null })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [131072] })}\n`);
          sock.write(`${JSON.stringify({ id: null, method: 'mining.notify', params: ['job'] })}\n`);
        }
        if (m.method === 'mining.authorize') sock.write(`${JSON.stringify({ id: m.id, result: true, error: null })}\n`);
      }
    });
  });
  const port = await new Promise((r) => strat.listen(0, () => r(strat.address().port)));
  try {
    // A reachable loopback endpoint -> resolved + pinned -> probed -> delivers work.
    conn.prepare("INSERT INTO pool_endpoints (host, port, worker_base, active) VALUES ('127.0.0.1', ?, 'bc1qx.w', 1)").run(port);
    let out = await observe.observe(conn, mockClient(), { now: NOW_MS, marketSkip: true, prevState: { rentals: {}, marketAt: NOW_MS } });
    assert.equal(out.snapshot.fetch_ok.endpoint, true);
    assert.equal(out.snapshot.endpoint.ok, true, 'a good endpoint is probed and delivers work');
    assert.equal(out.snapshot.endpoint.difficulty, 131072);

    // Flip it to the cloud-metadata address: it must be refused, never probed.
    conn.prepare("UPDATE pool_endpoints SET host = '169.254.169.254' WHERE active = 1").run();
    out = await observe.observe(conn, mockClient(), { now: NOW_MS, marketSkip: true, prevState: { rentals: {}, marketAt: NOW_MS } });
    assert.equal(out.snapshot.fetch_ok.endpoint, false, 'a blocked endpoint is refused and marked not-ok');
    assert.equal(out.snapshot.endpoint, null, 'a blocked endpoint is never probed (no result)');
  } finally {
    conn.prepare('DELETE FROM pool_endpoints').run();
    await new Promise((r) => strat.close(r));
  }
});
