'use strict';
/*
 * The header converter: SHA256 sats <-> BLAKE2b sats <-> fiat.
 *
 * Rates follow the BLAKE2b Sparrow wallet's method (Neoxa's BTCB2/USDC for BTCB2,
 * CoinGecko for BTC and for carrying dollars into other currencies), with
 * mempool.space as a fallback for the BTC side. What matters most here is how it
 * fails: a missing price must read as unavailable, never as zero or as a wrong
 * currency, and one source going down must not take the other side with it.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-fx-'));
process.env.DATA_DIR = DATA;

const fx = require('../fx');
const server = require('../server');
const db = require('../db');
const config = require('../config');
const ui = require('../../frontend/app.js');

// The API tests below stub this out so they never reach the network; these use the real one.
const realGetRates = fx.getRates;

// --- fixtures in the shape each feed returns ------------------------------------

const NEOXA = { BTCB2_USDC: { last_price: 368.12, lowest_ask: 371.9, highest_bid: 366.8 }, BTCB2_USDT: { last_price: 368.03 } };
const COINGECKO = {
  rates: {
    btc: { name: 'Bitcoin', unit: 'BTC', value: 1, type: 'crypto' },
    eth: { name: 'Ether', unit: 'ETH', value: 34.12, type: 'crypto' },
    usd: { name: 'US Dollar', unit: '$', value: 76855, type: 'fiat' },
    eur: { name: 'Euro', unit: '€', value: 68803, type: 'fiat' },
    jpy: { name: 'Japanese Yen', unit: '¥', value: 12153953, type: 'fiat' },
    xau: { name: 'Gold', unit: 'XAU', value: 19.1, type: 'commodity' },
  },
};
const MEMPOOL = { time: 1793673602, USD: 76800, EUR: 68750, GBP: 57473, CAD: 107635, CHF: 63066, AUD: 109865, JPY: 12153953 };

/** A fetch stand-in: url substring -> json body, Error (network), or { status }. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : new Error('no route');
    if (r instanceof Error) throw r;
    if (r && r.status) return { ok: false, status: r.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}
const ALL_UP = { neoxa: NEOXA, coingecko: COINGECKO, mempool: MEMPOOL };
const row = (rates, code) => rates.currencies.find((c) => c.code === code);

beforeEach(() => fx._reset());

// --- parsing ----------------------------------------------------------------------

test('BTCB2 is read from the USDC market, and a never-traded zero is no price at all', () => {
  assert.equal(fx.parseNeoxa(NEOXA), 368.12);
  assert.equal(fx.parseNeoxa({ BTCB2_USDC: { last_price: 0 } }), null, 'zero would read as "worthless"');
  assert.equal(fx.parseNeoxa({ BTCB2_USDT: { last_price: 368 } }), null, 'only the deep pair is used');
  assert.equal(fx.parseNeoxa(null), null);
  assert.equal(fx.validPrice('368.5'), 368.5);
  assert.equal(fx.validPrice(NaN), null);
});

test('CoinGecko yields fiat only, and is unusable without the dollar that anchors every cross rate', () => {
  const p = fx.parseCoinGecko(COINGECKO);
  assert.deepEqual(Object.keys(p.btc).sort(), ['eur', 'jpy', 'usd']);
  assert.equal(p.names.eur, 'Euro');
  const noUsd = { rates: { eur: COINGECKO.rates.eur } };
  assert.equal(fx.parseCoinGecko(noUsd), null);
});

test('mempool.space covers the major currencies as a fallback', () => {
  const p = fx.parseMempool(MEMPOOL);
  assert.equal(p.btc.usd, 76800);
  assert.equal(p.names.gbp, 'British Pound Sterling');
});

// --- the rate table ---------------------------------------------------------------

test('BTCB2 is carried into other currencies by the ratio of two fiat quotes only', () => {
  const t = fx.buildTable(368.12, fx.parseCoinGecko(COINGECKO));
  const eur = t.find((c) => c.code === 'eur');
  assert.equal(eur.btc, 68803);
  // BTCB2 in EUR = BTCB2 in USD x (EUR per USD), and CoinGecko's BTC price cancels out.
  assert.ok(Math.abs(eur.btcb2 - 368.12 * (68803 / 76855)) < 1e-9);
  assert.equal(t[0].code, 'usd', 'common currencies lead the picker');
});

test('with no BTC side, dollars are still offered: they need nothing but Neoxa', () => {
  const t = fx.buildTable(368.12, null);
  assert.deepEqual(t, [{ code: 'usd', name: 'US Dollar', btc: null, btcb2: 368.12 }]);
});

test('with no BTCB2 price, every currency is still listed for the SHA256 side', () => {
  const t = fx.buildTable(null, fx.parseCoinGecko(COINGECKO));
  assert.equal(t.length, 3);
  assert.ok(t.every((c) => c.btc != null && c.btcb2 == null));
});

// --- fetching, caching, failure -----------------------------------------------------

test('all sources up: both sides ok, one fetch each', async () => {
  const f = fakeFetch(ALL_UP);
  const r = await realGetRates({ fetchImpl: f, now: 1_000_000 });
  assert.equal(r.sources.btc.ok, true);
  assert.equal(r.sources.btc.source, 'CoinGecko');
  assert.equal(r.sources.btcb2.ok, true);
  assert.equal(row(r, 'usd').btc, 76855);
  assert.equal(f.calls.length, 2, 'mempool.space untouched while CoinGecko answers');
});

test('upstream is hit at most once a minute, however many pages ask', async () => {
  const f = fakeFetch(ALL_UP);
  await Promise.all([realGetRates({ fetchImpl: f, now: 1_000_000 }), realGetRates({ fetchImpl: f, now: 1_000_000 })]);
  await realGetRates({ fetchImpl: f, now: 1_000_000 + 59_000 });
  assert.equal(f.calls.length, 2, 'concurrent and repeat callers share one refresh');
  await realGetRates({ fetchImpl: f, now: 1_000_000 + 60_000 });
  assert.equal(f.calls.length, 4);
});

test('CoinGecko down: BTC falls back to mempool.space, and the source says so', async () => {
  const f = fakeFetch({ neoxa: NEOXA, coingecko: { status: 429 }, mempool: MEMPOOL });
  const r = await realGetRates({ fetchImpl: f, now: 1_000_000 });
  assert.equal(r.sources.btc.ok, true);
  assert.equal(r.sources.btc.source, 'mempool.space');
  assert.equal(row(r, 'usd').btc, 76800);
  assert.ok(row(r, 'gbp'), 'the fallback\'s currencies are offered');
});

test('Neoxa down: the SHA256 side keeps working and the BLAKE2b side reports why', async () => {
  const f = fakeFetch({ neoxa: new Error('ECONNREFUSED'), coingecko: COINGECKO });
  const r = await realGetRates({ fetchImpl: f, now: 1_000_000 });
  assert.equal(r.sources.btcb2.ok, false);
  assert.equal(r.sources.btcb2.error, 'unreachable');
  assert.equal(row(r, 'usd').btcb2, null);
  assert.equal(row(r, 'usd').btc, 76855);
});

test('a failed refresh serves the last good rate, marked stale, until it is too old to trust', async () => {
  await realGetRates({ fetchImpl: fakeFetch(ALL_UP), now: 1_000_000 });
  const down = fakeFetch({});
  const stale = await realGetRates({ fetchImpl: down, now: 1_000_000 + 5 * 60_000 });
  assert.equal(stale.sources.btcb2.stale, true);
  assert.equal(stale.sources.btcb2.ok, false);
  assert.equal(row(stale, 'usd').btcb2, 368.12, 'a blip does not blank the converter');

  const gone = await realGetRates({ fetchImpl: down, now: 1_000_000 + fx.STALE_MS + 60_000 });
  assert.equal(gone.sources.btcb2.stale, false);
  assert.equal(gone.currencies.length, 0, 'past the limit, no rate is better than an old one');
  assert.equal(gone.sources.btc.error, 'unreachable');
});

test('everything down from the start: nothing priced, every reason given, nothing thrown', async () => {
  const r = await realGetRates({ fetchImpl: fakeFetch({ coingecko: { status: 500 } }), now: 1_000_000 });
  assert.equal(r.currencies.length, 0);
  assert.equal(r.sources.btc.error, 'bad_response');
  assert.equal(r.sources.btcb2.error, 'unreachable');
});

test('a currency code is stored only in canonical form', () => {
  assert.equal(fx.normalizeCode(' EUR '), 'eur');
  assert.equal(fx.normalizeCode('euro'), null);
  assert.equal(fx.normalizeCode('e1r'), null);
  assert.equal(fx.normalizeCode(null), null);
});

// --- API --------------------------------------------------------------------------

let appServer;
let appPort;
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port: appPort, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null })); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
before(async () => {
  db.open(DATA);
  appServer = http.createServer(server.handleRequest);
  await new Promise((r) => appServer.listen(0, r));
  appPort = appServer.address().port;
  // Never reach the network from a test.
  fx.getRates = async () => ({ currencies: [{ code: 'usd', name: 'US Dollar', btc: 76855, btcb2: 368.12 }], sources: {}, refresh_seconds: 60 });
});
after(async () => {
  fx.getRates = realGetRates;
  await new Promise((r) => appServer.close(r));
  db.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('GET /api/fx works before setup is finished, defaulting to dollars', async () => {
  const r = await call('GET', '/api/fx');
  assert.equal(r.status, 200);
  assert.equal(r.json.fiat, 'usd');
  assert.equal(r.json.currencies[0].btcb2, 368.12);
  assert.ok(r.json.server_now > 0);
});

test('the chosen currency persists, shared across algorithms, and junk is refused', async () => {
  assert.equal((await call('POST', '/api/fx/currency', { code: 'EUR' })).json.fiat, 'eur');
  assert.equal((await call('GET', '/api/fx')).json.fiat, 'eur');
  // Accepted even though today's (stubbed) list has only dollars: an outage must not
  // refuse, or later erase, a preference.
  assert.equal((await call('POST', '/api/fx/currency', { code: 'chf' })).status, 200);
  config.set(db.get(), 'algorithm', { active: 'blake2b' });
  assert.equal((await call('GET', '/api/fx')).json.fiat, 'chf', 'not per-algorithm');
  assert.equal((await call('POST', '/api/fx/currency', { code: 'dollars' })).status, 400);
  assert.equal((await call('POST', '/api/fx/currency', {})).status, 400);
});

// --- front-end math ---------------------------------------------------------------

const ROW = { btc: 76855, btcb2: 368.12 };

test('converter: the typed field is kept exactly, the others derived through fiat', () => {
  const v = ui.fxConvert('sha', 1e8, ROW);
  assert.equal(v.sha, 1e8);
  assert.equal(v.fiat, 76855);
  assert.ok(Math.abs(v.b2 - (76855 / 368.12) * 1e8) < 1e-3);
  // Round trip through the other two lands back where it started.
  const back = ui.fxConvert('b2', v.b2, ROW);
  assert.ok(Math.abs(back.sha - 1e8) < 1e-3);
});

test('converter: a side with no price comes out empty, not zero', () => {
  const v = ui.fxConvert('fiat', 100, { btc: 76855, btcb2: null });
  assert.equal(v.b2, null);
  assert.ok(v.sha > 0);
  assert.deepEqual(ui.fxConvert('b2', 5, { btc: 76855, btcb2: null }), { sha: null, b2: 5, fiat: null });
});

test('converter input: separators, shortcuts and symbols accepted; nonsense and negatives refused', () => {
  const cases = { '1,000,000': 1e6, '1 000 000': 1e6, '2.5k': 2500, '3M': 3e6, '1e6': 1e6, '$10.50': 10.5, '.5': 0.5, '0': 0 };
  for (const [t, n] of Object.entries(cases)) assert.equal(ui.fxParse(t), n, t);
  for (const t of ['', 'abc', '-5', '1,2,3', '5kk', '1e400']) assert.equal(ui.fxParse(t), null, t);
});

test('converter input: a decimal comma is read as one wherever it cannot be grouping', () => {
  // Typed in a comma-decimal locale, 1,50 euros read as 150 would be a 100x error.
  const cases = { '1,5': 1.5, '1,50': 1.5, '0,25': 0.25, '1.000,50': 1000.5, '1,000.50': 1000.5, '1,000': 1000, '1,000,000': 1e6, '1.000.000': 1e6, '2,5k': 2500 };
  for (const [t, n] of Object.entries(cases)) assert.equal(ui.fxParse(t), n, t);
});

test('converter output: grouped whole sats, currency precision, and no misleading zeros', () => {
  assert.equal(ui.fxFormat(20877702922.96, 0), '20,877,702,923');
  assert.equal(ui.fxFormat(76855.123, 2), '76,855.12');
  assert.equal(ui.fxFormat(0.000769, 2), '0.000769', 'one SHA256 sat in dollars is not "0.00"');
  assert.equal(ui.fxFormat(0.00479, 0), '0.00479', 'one BLAKE2b sat in SHA256 sats is not "0"');
  assert.equal(ui.fxFormat(4.4e20, 0), '440,000,000,000,000,000,000', 'the largest amounts stay readable');
  assert.equal(ui.fxFormat(null, 2), '');
  assert.equal(ui.fxMinorDigits('jpy'), 0);
  assert.equal(ui.fxMinorDigits('kwd'), 3);
});

test('converter age text', () => {
  assert.equal(ui.fxAgeText(3), 'just now');
  assert.equal(ui.fxAgeText(42), '42s ago');
  assert.equal(ui.fxAgeText(190), '3 min ago');
  assert.equal(ui.fxAgeText(null), '');
});
