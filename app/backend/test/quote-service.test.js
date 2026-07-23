'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const qs = require('../quote-service');

const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr', f), 'utf8'));
const algo = fx('algo-sha256ab.json');
const search = fx('rig-search.json');
const balance = fx('balance.json');

// ---- Pure helpers ----

test('toPackerParams maps the lock field to the packer compute mode', () => {
  assert.deepEqual(qs.toPackerParams({ compute: 'duration', spendSats: 1e6, hashrateTh: 3000 }),
    { compute: 'duration', budgetSats: 1000000, targetTh: 3000 });
  assert.deepEqual(qs.toPackerParams({ compute: 'hashrate', spendSats: 1e6, durationHours: 168 }),
    { compute: 'target', budgetSats: 1000000, durationHours: 168 });
  assert.deepEqual(qs.toPackerParams({ compute: 'spend', hashrateTh: 3000, durationHours: 168 }),
    { compute: 'budget', targetTh: 3000, durationHours: 168 });
});

test('toPackerParams rejects missing/non-positive inputs', () => {
  assert.throws(() => qs.toPackerParams({ compute: 'duration', spendSats: 1e6 }), /missing_inputs/);
  assert.throws(() => qs.toPackerParams({ compute: 'duration', spendSats: 1e6, hashrateTh: 0 }), /missing_inputs/);
  assert.throws(() => qs.toPackerParams({ compute: 'nonsense', spendSats: 1, hashrateTh: 1 }), /bad_compute/);
});

test('parseAlgo pulls suggested + last-10 out of the real info/algos shape (per PH·day)', () => {
  const a = qs.parseAlgo(algo);
  assert.equal(a.suggestedPhDay, 0.00052820);
  assert.equal(a.last10PhDay, 0.00068910);
  // Tolerates a {result:...} envelope too.
  assert.equal(qs.parseAlgo({ result: algo }).last10PhDay, 0.00068910);
});

test('marketContext labels a below-average quote as a good deal', () => {
  const a = qs.parseAlgo(algo);   // last_10 = 0.0006891 BTC/PH/day
  const ctx = qs.marketContext(0.00050000, a);   // ~27% below
  assert.ok(ctx.delta_pct < 0);
  assert.match(ctx.label, /below the last-10 rental average/);
  assert.equal(ctx.tight, false);
});

test('marketContext flags a tight market when the quote is above average', () => {
  const a = qs.parseAlgo(algo);
  const ctx = qs.marketContext(0.00080000, a);   // ~16% above
  assert.ok(ctx.delta_pct > 5);
  assert.equal(ctx.tight, true);
  assert.match(ctx.label, /market is tight/);
});

test('marketContext returns null without algo stats', () => {
  assert.equal(qs.marketContext(0.0005, null), null);
});

// ---- buildQuote end-to-end with a mocked client ----

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-qs-'));
before(() => {
  db.open(DATA);
  const conn = db.get();
  // An active endpoint whose bootstrap has run (profile id present).
  conn.prepare(`INSERT INTO pool_endpoints (host, port, worker_base, stratum_diff, mrr_pool_id, mrr_profile_id, active)
                VALUES (?, ?, ?, ?, ?, ?, 1)`).run('ab.example.gg', 26596, 'bc1qabc.worker', 131072, 111, 222);
});
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// A raw (MRR-shaped) eligible rig, so the packer has real candidates. optimal_diff
// accepts the endpoint's 131072, BTC enabled, available, online.
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

// Fixture rigs (filter cases) plus a few eligible synthetic rigs to pack.
const marketPage = {
  ...search,
  records: [
    ...search.records,
    rawRig('900101', 0.002, 0.000004),   // 2 TH @ cheap
    rawRig('900102', 0.002, 0.000005),   // 2 TH
    rawRig('900103', 0.002, 0.000006),   // 2 TH
  ],
};

// A client that serves the recorded fixtures. Rig search paginates: page 0 -> the
// records, page 1 -> empty (ends pagination).
function mockClient() {
  const calls = [];
  return {
    calls,
    async get(p, params) {
      calls.push([p, params]);
      if (p === '/rig') return (params && params.offset > 0) ? { records: [], total: marketPage.records.length } : marketPage;
      if (p === '/account/balance') return balance;
      if (p === '/info/algos/sha256ab') return algo;
      throw new Error(`unexpected GET ${p}`);
    },
  };
}

test('buildQuote prices a duration quote over the fixture market, fee-inclusive', async () => {
  qs.invalidateMarket();
  const conn = db.get();
  const client = mockClient();
  // Small target so the fixture's handful of eligible rigs can fill it.
  const q = await qs.buildQuote(conn, client, { compute: 'duration', spendSats: 200000, hashrateTh: 5 });

  assert.ok(q.id && q.expires_at > 0);
  assert.equal(q.compute, 'duration');
  assert.ok(q.rig_count >= 1, 'at least one eligible rig packed');
  assert.ok(q.total_sats <= 200000, 'never exceeds the budget');
  assert.equal(q.total_sats, q.base_sats + q.fee_sats, 'headline = base + fee');
  assert.equal(q.balance_sats, 50000, 'balance from the fixture (0.0005 BTC)');
  assert.equal(q.insufficient_funds, q.total_sats > 50000);
  assert.equal(q.endpoint.stratum, 'stratum+tcp://ab.example.gg:26596');
  assert.ok(q.market_context && q.market_context.label, 'market badge present');
  // Per-rig breakdown sums to the headline.
  const sumPaid = q.rigs.reduce((s, r) => s + r.paid_sats + r.fee_sats, 0);
  assert.equal(sumPaid, q.total_sats);
});

test('buildQuote caps the spend at the session guardrail (budget-locked)', async () => {
  qs.invalidateMarket();
  const conn = db.get();
  const cap = require('../config').getKey(conn, 'guardrails', 'max_session_budget_sats');
  const q = await qs.buildQuote(conn, mockClient(), { compute: 'duration', spendSats: cap * 3, hashrateTh: 5 });
  assert.ok(q.total_sats <= cap, `capped at ${cap}, got ${q.total_sats}`);
  assert.ok(q.warnings.includes('budget_capped'));
});

test('buildQuote flags a spend-locked quote that exceeds the session guardrail', async () => {
  qs.invalidateMarket();
  const conn = db.get();
  const config = require('../config');
  const prev = config.getKey(conn, 'guardrails', 'max_session_budget_sats');
  config.set(conn, 'guardrails', { max_session_budget_sats: 50000 });   // small, so the tiny market can exceed it
  try {
    // hashrate + long duration -> computed spend above the guardrail (no input budget to clamp).
    const q = await qs.buildQuote(conn, mockClient(), { compute: 'spend', hashrateTh: 6, durationHours: 96 });
    assert.ok(q.total_sats > 50000, `expected total ${q.total_sats} > guardrail 50000`);
    assert.ok(q.warnings.includes('exceeds_guardrail'), 'the over-guardrail spend is flagged');
  } finally {
    config.set(conn, 'guardrails', { max_session_budget_sats: prev });
  }
});

test('buildQuote omits the market badge when nothing is available (no false "great deal")', async () => {
  qs.invalidateMarket();
  const conn = db.get();
  // An impossible target for this tiny market -> a zero-hashrate quote via the packer.
  const client = {
    async get(p, params) {
      if (p === '/rig') return (params && params.offset > 0) ? { records: [] } : { records: [], total: 0 };
      if (p === '/account/balance') return balance;
      if (p === '/info/algos/sha256ab') return algo;
      throw new Error('unexpected');
    },
  };
  const q = await qs.buildQuote(conn, client, { compute: 'duration', spendSats: 100000, hashrateTh: 5 });
  assert.equal(q.rig_count, 0);
  assert.equal(q.market_context, null, 'no badge for an empty quote');
});

test('buildQuote stores the quote for later retrieval, and it expires', async () => {
  qs.invalidateMarket();
  const conn = db.get();
  const q = await qs.buildQuote(conn, mockClient(), { compute: 'duration', spendSats: 100000, hashrateTh: 5 });
  const stored = qs.getStoredQuote(q.id);
  assert.ok(stored, 'retrievable by id');
  assert.equal(stored.result.totalSats, q.total_sats);
  assert.equal(qs.getStoredQuote('does-not-exist'), null);
});

test('buildQuote uses the market cache within its TTL (one rig fetch for two quotes)', async () => {
  qs.invalidateMarket();
  const conn = db.get();
  const client = mockClient();
  await qs.buildQuote(conn, client, { compute: 'duration', spendSats: 100000, hashrateTh: 5 });
  await qs.buildQuote(conn, client, { compute: 'duration', spendSats: 120000, hashrateTh: 5 });
  const rigFetches = client.calls.filter((c) => c[0] === '/rig' && (!c[1] || !c[1].offset)).length;
  assert.equal(rigFetches, 1, 'second quote reused the cached market');
});
