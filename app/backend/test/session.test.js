'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const qs = require('../quote-service');
const session = require('../session');
const { MrrApiError, MrrAmbiguousError } = require('../mrr-client');

const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr', f), 'utf8'));
const balance = fx('balance.json');   // 0.0005 BTC = 50,000 sats confirmed
const algo = fx('algo-sha256ab.json');
const rentalCreated = fx('rental-created.json');

function rawRig(id, hashPh, hourBtc) {
  return {
    id, name: `rig-${id}`, owner: `owner-${id}`, type: 'sha256ab',
    status: { status: 'available', rented: false, online: true }, online: true,
    poolstatus: 'online', region: 'us-east', rpi: '95.00',
    optimal_diff: { min: '1000', max: '2000000' }, extensions: true,
    price: { type: 'ph', BTC: { currency: 'BTC', price: '0.00050000', hour: String(hourBtc), min_rental_length: 3, enabled: true } },
    minhours: '3', maxhours: '96',
    hashrate: {
      advertised: { hash: String(hashPh), type: 'ph' },
      last_5min: { hash: String(hashPh * 1e6), type: 'mh' },
      last_15min: { hash: String(hashPh * 1e6), type: 'mh' },
      last_30min: { hash: String(hashPh * 1e6), type: 'mh' },
    },
    available_status: 'available',
  };
}

// A configurable mock MRR client. `opts.rentFail`: 'ambiguous' | 'clean' | id-map;
// `opts.priceMult`: scales all rig hour prices (to force a reprice delta).
function mockClient(opts = {}) {
  const prices = opts.prices || [0.000004, 0.000005, 0.000006];
  const state = { priceMult: opts.priceMult || 1, rentFail: opts.rentFail, badId: opts.badId, puts: [], nextId: 6000000 };
  const rigs = () => prices.map((hr, i) => rawRig(String(900201 + i), 0.002, hr * state.priceMult));
  return {
    state,
    async get(p, params) {
      if (p === '/rig') return (params && params.offset > 0) ? { records: [], total: 3 } : { records: rigs(), total: 3, offset: 0, count: 3 };
      if (p === '/account/balance') return balance;
      if (p === '/info/algos/sha256ab') return algo;
      throw new Error(`unexpected GET ${p}`);
    },
    async put(p, params) {
      state.puts.push([p, params]);
      if (p === '/rental') {
        if (state.rentFail === 'ambiguous') throw new MrrAmbiguousError('timeout on PUT /rental');
        if (state.rentFail === 'clean') throw new MrrApiError('rig no longer available');
        if (typeof state.rentFail === 'function') { const r = state.rentFail(params, state); if (r) throw r; }
        if (state.badId) return { ok: true };   // resolves but carries no usable id
        return { ...rentalCreated, id: String(state.nextId++) };
      }
      if (/^\/rental\/\d+\/pool\/[01]$/.test(p)) return { message: 'ok' };   // primary (0) + Ocean fallback (1)
      throw new Error(`unexpected PUT ${p}`);
    },
  };
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-session-'));
before(() => {
  db.open(DATA);
  db.get().prepare(`INSERT INTO pool_endpoints (host, port, worker_base, stratum_diff, mrr_pool_id, mrr_profile_id, active)
                    VALUES (?, ?, ?, ?, ?, ?, 1)`).run('ab.example.gg', 26596, 'bc1qabc.phash', 131072, 111, 953073);
});
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => {
  const conn = db.get();
  conn.prepare('DELETE FROM rentals').run();
  conn.prepare('DELETE FROM spend_events').run();
  conn.prepare('DELETE FROM decisions').run();
  conn.prepare('DELETE FROM sessions').run();
  conn.prepare('DELETE FROM alerts').run();
  qs.invalidateMarket();
});

async function makeQuote(client, over = {}) {
  return qs.buildQuote(db.get(), client, { compute: 'duration', spendSats: 40000, hashrateTh: 4, ...over });
}

// ---- Pure ----

test('rateCapPhDay converts per-TH price to a +1% per-PH cap, rounded like the API', () => {
  assert.equal(session.rateCapPhDay(0.00000050), Number((0.0005 * 1.01).toFixed(8)));
});

test('oceanFallbackWorker uses the BTC address with a .fallback tag', () => {
  assert.equal(session.oceanFallbackWorker('bc1qabc.phash'), 'bc1qabc.fallback');
  assert.equal(session.oceanFallbackWorker('bc1qabc'), 'bc1qabc.fallback');
  assert.equal(session.oceanFallbackWorker(''), null);
  assert.equal(session.oceanFallbackWorker(null), null);
});

test('rentOne attaches the Ocean fallback at pool/1 when enabled (same address, .fallback worker)', async () => {
  const client = mockClient();
  const endpoint = { host: 'ab.example.gg', port: 26596, worker_base: 'bc1qabc.phash', mrr_profile_id: 953073 };
  const intent = { rigId: 42, lengthHours: 3, rateCapPhDay: 0.001, advertisedTh: 4 };
  const res = await session.rentOne(client, intent, endpoint, { fallbackOcean: true });
  assert.equal(res.fallback, 'ocean');
  const fb = client.state.puts.find((c) => /\/pool\/1$/.test(c[0]));
  assert.ok(fb, 'a pool/1 override was issued');
  assert.equal(fb[1].host, 'bip110.mine.ocean.xyz');
  assert.equal(fb[1].port, 3110);
  assert.equal(fb[1].user, 'bc1qabc.fallback', 'same BTC address, .fallback worker tag');
});

test('rentOne skips the fallback pool when disabled', async () => {
  const client = mockClient();
  const endpoint = { host: 'ab.example.gg', port: 26596, worker_base: 'bc1qabc.phash', mrr_profile_id: 953073 };
  const intent = { rigId: 42, lengthHours: 3, rateCapPhDay: 0.001, advertisedTh: 4 };
  const res = await session.rentOne(client, intent, endpoint, { fallbackOcean: false });
  assert.equal(res.fallback, 'off');
  assert.ok(!client.state.puts.some((c) => /\/pool\/1$/.test(c[0])), 'no pool/1 override issued');
});

test('planIntents produces one intent per packed rig at the quote duration', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  const stored = qs.getStoredQuote(q.id);
  const intents = session.planIntents(stored);
  assert.equal(intents.length, stored.result.rigs.length);
  assert.ok(intents.every((i) => i.lengthHours === stored.result.durationHours && i.rateCapPhDay > 0));
});

// ---- DRY-RUN ----

test('DRY-RUN rehearses every rental without spending or writing rentals', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: true });

  assert.equal(r.dry_run, true);
  assert.ok(r.planned.length >= 1);
  assert.equal(r.executed.length, 0);
  assert.equal(client.state.puts.length, 0, 'no mutations issued');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'no rentals persisted');
  const notes = db.get().prepare("SELECT note FROM decisions WHERE note LIKE 'DRY-RUN%'").all();
  assert.equal(notes.length, r.planned.length, 'a would-rent note per planned rig');
  assert.match(notes[0].note, /would rent rig #\d+ .* for .*h at \d+ sats/);
  assert.equal(db.get().prepare("SELECT state FROM sessions").get().state, 'ended');
});

// ---- LIVE ----

test('LIVE creates each rental, applies the per-rental worker override, and persists rows', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });

  assert.equal(r.dry_run, false);
  assert.ok(r.executed.length >= 1);
  assert.equal(r.executed.length, r.planned.length);
  const rows = db.get().prepare('SELECT mrr_id, worker_name, health FROM rentals ORDER BY id').all();
  assert.equal(rows.length, r.executed.length);
  assert.ok(rows.every((x) => x.mrr_id > 0 && /^bc1qabc\.phash-r\d+$/.test(x.worker_name) && x.health === 'pending'));
  // A create + a pool/0 override for each rig.
  const creates = client.state.puts.filter((c) => c[0] === '/rental').length;
  const overrides = client.state.puts.filter((c) => /\/pool\/0$/.test(c[0])).length;
  assert.equal(creates, r.executed.length);
  assert.equal(overrides, r.executed.length);
  // The protective rate cap is sent on every create.
  assert.ok(client.state.puts.filter((c) => c[0] === '/rental').every((c) => c[1].rate && c[1].rate.price > 0 && c[1].rate.type === 'ph'));
});

test('a live rental captures diff telemetry (endpoint diff + optimal range + in-range flag)', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  await session.startSession(db.get(), client, q.id, { dryRun: false });
  const row = db.get().prepare('SELECT endpoint_diff, optimal_diff_min, optimal_diff_max, diff_in_range FROM rentals ORDER BY id LIMIT 1').get();
  assert.equal(row.endpoint_diff, 131072);        // the test endpoint's stratum_diff
  assert.equal(row.optimal_diff_min, 1000);
  assert.equal(row.optimal_diff_max, 2000000);
  assert.equal(row.diff_in_range, 1);             // 131072 ∈ [1000, 2000000]
});

test('an ambiguous create halts the session and is never retried', async () => {
  const client = mockClient({ rentFail: 'ambiguous' });
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });

  assert.equal(r.halted, true);
  assert.equal(r.halt_reason, 'ambiguous');
  assert.equal(client.state.puts.filter((c) => c[0] === '/rental').length, 1, 'exactly one create attempt — no retry');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0);
  const halt = db.get().prepare("SELECT note FROM decisions WHERE note LIKE 'ambiguous_halt%'").get();
  assert.ok(halt, 'the halt is recorded for reconciliation');
});

test('a clean failure re-packs the shortfall from the next candidate', async () => {
  // Equal-priced rigs so the replacement for a taken rig fits the same budget.
  let failed = false;
  const client = mockClient({ prices: [0.000004, 0.000004, 0.000004], rentFail: (params) => {
    if (!failed && Number(params.rig) === 900201) { failed = true; return new MrrApiError('taken'); }
    return null;
  } });
  const q = await makeQuote(client, { spendSats: 40000, hashrateTh: 2 });   // one rig, then re-pack its replacement
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });

  assert.equal(r.halted, false);
  // The failed rig is not among the executed set, but the target is still covered by a re-pack.
  assert.ok(!r.executed.some((e) => e.rig_id === 900201));
  const repack = db.get().prepare("SELECT note FROM decisions WHERE note LIKE 're-pack round%'").get();
  assert.ok(repack, 'a re-pack round was recorded');
});

test('a fired endpoint_down alert blocks a LIVE confirm (but a DRY-RUN rehearsal is still allowed)', async () => {
  const alerts = require('../alerts');
  const client = mockClient();
  const q = await makeQuote(client);
  // Trip the endpoint_down gate (threshold 0 -> arms and fires at once).
  alerts.runTransition(db.get(), { kind: 'endpoint_down', bad: true, now: Date.now(), thresholdMs: 0 });
  assert.equal(alerts.newRentsHalted(db.get()), true);
  await assert.rejects(
    () => session.startSession(db.get(), client, q.id, { dryRun: false }),
    (e) => e instanceof session.SessionError && e.code === 'endpoint_down',
  );
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM sessions').get().n, 0, 'no session row created when gated');
  // A DRY-RUN can't spend, so the outage doesn't block the rehearsal.
  const q2 = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q2.id, { dryRun: true });
  assert.equal(r.dry_run, true);
});

test('a LIVE session that rents nothing is ended immediately (no zombie active session)', async () => {
  const client = mockClient({ rentFail: 'clean' });   // every create fails cleanly
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });
  assert.equal(r.executed.length, 0);
  assert.equal(db.get().prepare('SELECT state FROM sessions ORDER BY id DESC LIMIT 1').get().state, 'ended', 'empty live session ended, not zombie-active');
  // A new session is NOT blocked (no lingering active session).
  const q2 = await makeQuote(client);
  await assert.doesNotReject(() => session.startSession(db.get(), client, q2.id, { dryRun: true }));
});

test('an ambiguous create fires needs_reconcile and ends the empty session (no lockout)', async () => {
  const client = mockClient({ rentFail: 'ambiguous' });
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });
  assert.equal(r.halted, true);
  assert.ok(db.get().prepare("SELECT 1 FROM alerts WHERE kind = 'needs_reconcile' AND state = 'fired'").get(), 'needs_reconcile fired for the untracked orphan');
  assert.equal(db.get().prepare('SELECT state FROM sessions ORDER BY id DESC LIMIT 1').get().state, 'ended');
});

test('a pricier re-pack replacement never pushes spend past the budget', async () => {
  // a,b are cheap and packed; c is pricier. When a is taken, the re-pack can only pull c,
  // whose cost would bust the budget — the gate must stop rather than overspend.
  let failed = false;
  const client = mockClient({ prices: [0.000004, 0.000004, 0.0000044], rentFail: (params) => {
    if (!failed && Number(params.rig) === 900201) { failed = true; return new MrrApiError('taken'); }
    return null;
  } });
  const budget = 10000;
  const q = await makeQuote(client, { spendSats: budget, hashrateTh: 4 });
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });

  assert.ok(r.total_sats <= budget, `spent ${r.total_sats} must not exceed budget ${budget}`);
  const persisted = db.get().prepare('SELECT COALESCE(SUM(paid_sats + fee_sats), 0) s FROM rentals').get().s;
  assert.ok(persisted <= budget, `persisted spend ${persisted} must not exceed budget ${budget}`);
});

test('a create that resolves without a usable rental id halts as ambiguous (nothing persisted)', async () => {
  const client = mockClient({ badId: true });
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });
  assert.equal(r.halted, true);
  assert.equal(r.halt_reason, 'ambiguous');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM rentals').get().n, 0, 'no NaN-id rental persisted');
});

test('LIVE refuses to start when the confirmed balance cannot cover the total', async () => {
  // A quote whose total exceeds the 50k-sat fixture balance.
  const client = mockClient();
  const q = await makeQuote(client, { spendSats: 5000000, hashrateTh: 6 });
  await assert.rejects(
    () => session.startSession(db.get(), client, q.id, { dryRun: false }),
    (e) => e.code === 'insufficient_balance',
  );
});

test('an expired/unknown quote id is refused', async () => {
  await assert.rejects(
    () => session.startSession(db.get(), mockClient(), 'nope', { dryRun: true }),
    (e) => e.code === 'quote_expired',
  );
});

// ---- Concurrency ----

test('two concurrent confirms for the same quote: exactly one executes', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  const [a, b] = await Promise.allSettled([
    session.startSession(db.get(), client, q.id, { dryRun: false }),
    session.startSession(db.get(), client, q.id, { dryRun: false }),
  ]);
  const outcomes = [a, b];
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'one succeeded');
  assert.equal(rejected.length, 1, 'the other was blocked');
  assert.equal(rejected[0].reason.code, 'session_in_progress');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM sessions').get().n, 1, 'only one session opened');
});

// ---- persistRental (direct) ----

function seedSession() {
  const now = Math.floor(Date.now() / 1000);
  return Number(db.get().prepare(
    "INSERT INTO sessions (mode, state, created_at, started_at) VALUES ('quick', 'active', ?, ?)",
  ).run(now, now).lastInsertRowid);
}

function baseIntent(over = {}) {
  return {
    rigId: 900301, rigName: 'sentinel-rig', region: 'us-east', advertisedTh: 2,
    lengthHours: 3, paidSats: 100, feeSats: 20, rateBtcThDay: 0.0000005,
    endpointDiff: 131072, optimalDiffMin: 1000, optimalDiffMax: 2000000, diffInRange: true, ...over,
  };
}

test('persistRental treats an end_unix<=0 sentinel as "not finalized": stores start+length, never 0', () => {
  const sid = seedSession();
  const start = 1784677189;
  // end_unix 0 (MRR's "not finalized" sentinel) and its empty-string variant ('' -> Number 0).
  session.persistRental(db.get(), sid, baseIntent({ rigId: 900301 }), { mrrId: 7001, worker: 'w-r7001', created: { start_unix: start, end_unix: 0 } });
  session.persistRental(db.get(), sid, baseIntent({ rigId: 900302 }), { mrrId: 7002, worker: 'w-r7002', created: { start_unix: start, end_unix: '' } });

  const expectedEnd = start + Math.round(3 * 3600);
  for (const mrrId of [7001, 7002]) {
    const row = db.get().prepare('SELECT start_ts, end_ts FROM rentals WHERE mrr_id = ?').get(mrrId);
    assert.equal(row.start_ts, start);
    assert.notEqual(row.end_ts, 0, 'a 0 end_ts would read as already-ended and close the session under a live rental');
    assert.equal(row.end_ts, expectedEnd, 'end_ts falls back to start + round(lengthHours*3600)');
  }
});

test('persistRental falls back to nowSec when start_unix<=0 (and derives end from that)', () => {
  const sid = seedSession();
  const before = Math.floor(Date.now() / 1000);
  session.persistRental(db.get(), sid, baseIntent({ rigId: 900303 }), { mrrId: 7003, worker: 'w-r7003', created: { start_unix: 0, end_unix: 0 } });
  const after = Math.floor(Date.now() / 1000);
  const row = db.get().prepare('SELECT start_ts, end_ts FROM rentals WHERE mrr_id = ?').get(7003);
  assert.ok(row.start_ts >= before && row.start_ts <= after, 'start_ts fell back to nowSec');
  assert.equal(row.end_ts, row.start_ts + Math.round(3 * 3600));
});

test('a LIVE rent writes a fee-inclusive spend_events row (kind=rent) tied to the session and rental', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });
  assert.ok(r.executed.length >= 1);

  const ex = r.executed[0];
  const ev = db.get().prepare("SELECT * FROM spend_events WHERE mrr_id = ? AND kind = 'rent'").get(ex.mrr_id);
  assert.ok(ev, 'a rent spend_event was recorded for the executed rental');
  assert.equal(ev.sats, ex.paid_sats + ex.fee_sats, 'spend_events.sats is the fee-inclusive amount');
  assert.equal(ev.session_id, r.session_id, 'attributed to the session');
  // One rent event per executed rental — nothing double-counted.
  const n = db.get().prepare("SELECT COUNT(*) c FROM spend_events WHERE session_id = ? AND kind = 'rent'").get(r.session_id).c;
  assert.equal(n, r.executed.length);
});

// ---- Reprice ----

test('a >2% price move at confirm returns a re-confirm instead of executing', async () => {
  const client = mockClient();
  const q = await makeQuote(client);
  // Market jumps ~20% before confirm. NOTE: no manual cache invalidation — the confirm
  // path must force its own fresh fetch, or a within-30s confirm would miss the move.
  client.state.priceMult = 1.2;
  const r = await session.startSession(db.get(), client, q.id, { dryRun: false });
  assert.equal(r.needs_reconfirm, true);
  assert.ok(r.quote && r.quote.id !== q.id, 'a fresh quote is returned to re-confirm');
  assert.equal(client.state.puts.length, 0, 'nothing executed');
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM sessions').get().n, 0, 'no session opened');
});
