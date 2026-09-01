'use strict';
/*
 * Prices carry the unit the algorithm is quoted in, end to end.
 *
 * sha256ab is quoted per PH and blake2b per TH, so the same number means a
 * thousandfold different price. The app used to hardcode PH everywhere: in the rate
 * cap it sends to the marketplace, in the ceiling it enforces, in the market prices
 * it stores and in the labels beside all of them.
 *
 * None of that throws on blake2b. It sends a protective cap a thousand times too
 * high, on the algorithm where a TH costs 2,425x more than it does on sha256ab, and
 * the number the user is shown to judge it by is wrong in the same direction. So the
 * assertions here are all about the unit travelling with the number.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const session = require('../session');
const decide = require('../engine/decide');
const market = require('../market');
const units = require('../units');
const algos = require('../algos');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-units-'));
  try { return db.open(dir), fn(db.get()); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A client that records what was sent rather than sending it. */
function recordingClient() {
  const puts = [];
  return {
    puts,
    async put(p, body) {
      puts.push([p, body]);
      return /\/rental$/.test(p) ? { id: 9001 } : { ok: true };
    },
    async get() { return {}; },
  };
}

const ENDPOINT = { host: 'ab.example.gg', port: 26596, worker_base: 'bc1qabc.phash', mrr_profile_id: 953073 };

test('a rental sends the rate cap in the unit it names, for each algorithm', async () => {
  // rate.type and rate.price are one statement: "no more than this much per that
  // much". Sending a per-PH number labelled 'ph' for a per-TH market is the failure
  // this whole change exists to stop, and it is not one the API would reject.
  for (const [algo, unit] of [['sha256ab', 'ph'], ['blake2b', 'th']]) {
    const client = recordingClient();
    const intent = {
      rigId: 42, lengthHours: 3, advertisedTh: 4,
      priceUnit: unit,
      rateCapUnitDay: session.rateCapUnitDay(0.0000005, unit),
    };
    await session.rentOne(client, intent, ENDPOINT, { fallbackPool: null });
    const create = client.puts.find((c) => /\/rental$/.test(c[0]));
    assert.equal(create[1].rate.type, unit, `${algo} names its own unit`);
    assert.equal(create[1].rate.price, intent.rateCapUnitDay);
  }
});

test('the cap is the price in the named unit plus 1%, at the API\'s precision', () => {
  // Real prices, from the live fixtures. blake2b's suggested rate is 0.001281 BTC per
  // TH·day; sha256ab's is 0.0005282 per PH·day, which is 5.282e-7 per TH.
  assert.equal(session.rateCapUnitDay(0.001281, 'th'), Number((0.001281 * 1.01).toFixed(8)));
  assert.equal(session.rateCapUnitDay(5.282e-7, 'ph'), Number((0.0005282 * 1.01).toFixed(8)));

  // The API takes 8 decimal places, so the unit is not only a label: a sha256ab price
  // expressed per TH is around 5e-7 and loses most of its significant digits at that
  // precision, which is presumably why the marketplace quotes it per PH at all. Each
  // algorithm's own unit is the one where its prices have room.
  assert.equal(session.rateCapUnitDay(5.282e-7, 'th'), 0.00000053, 'three digits left');
  assert.ok(String(session.rateCapUnitDay(0.001281, 'th')).length > 6, 'blake2b keeps its digits');

  // decide's copy of the arithmetic must not drift from session's.
  const rig = { priceBtcThDay: 0.001281 };
  assert.equal(decide.rateCapUnitDay(rig, 'ph'), session.rateCapUnitDay(0.001281, 'ph'));
  assert.equal(decide.rateCapUnitDay(rig, 'th'), session.rateCapUnitDay(0.001281, 'th'));
});

test('the blended ceiling means what the active algorithm says it means', () => {
  // 100,000 entered against blake2b is 100,000 sats per TH·day. Read as sats per
  // PH·day, which is what the fixed 1e11 did, it becomes a cap a thousand times
  // tighter than intended and every rig fails it — the safe direction, but it means
  // the app simply cannot rent. Entered the other way round it is a thousand times
  // looser, which is the direction that spends money.
  const ceiling = 100000;
  assert.equal(units.btcThDayFromSatsPerUnitDay(ceiling, 'th'), ceiling / 1e8);
  assert.equal(units.btcThDayFromSatsPerUnitDay(ceiling, 'ph'), ceiling / 1e11);
  // Round trip, both ways.
  for (const unit of ['ph', 'th']) {
    const btcThDay = units.btcThDayFromSatsPerUnitDay(ceiling, unit);
    assert.ok(Math.abs(units.satsPerUnitDay(btcThDay, unit) - ceiling) < 1e-6, unit);
  }
});

test('the settings schema labels the ceiling in the active algorithm\'s unit', () => {
  withDb((conn) => {
    const sha = config.settings(conn).guardrails;
    assert.equal(sha.blended_ceiling_sats_unit_day.unit, 'sats/PH·day');
    assert.match(sha.rate_ceiling_sats_th_hour.help, /SHA256 rig runs ~2\.2 sats\/TH\/hr/);

    config.set(conn, 'algorithm', { active: 'blake2b' });
    const b2 = config.settings(conn).guardrails;
    assert.equal(b2.blended_ceiling_sats_unit_day.unit, 'sats/TH·day');
    // The number is an anchor read from the live market, so it moves; what must hold is
    // that the help names THIS algorithm and quotes its own figure, not the other one's.
    assert.match(b2.rate_ceiling_sats_th_hour.help, /BLAKE2b rig runs ~\d/);
    assert.doesNotMatch(b2.rate_ceiling_sats_th_hour.help, /SHA256/);

    // Same keys and same bounds either way — only the human-facing parts move.
    assert.deepEqual(Object.keys(sha), Object.keys(b2));
    assert.equal(sha.blended_ceiling_sats_unit_day.type, b2.blended_ceiling_sats_unit_day.type);
    assert.equal(sha.blended_ceiling_sats_unit_day.min, b2.blended_ceiling_sats_unit_day.min);
    // The schema is data for the UI; the internal hook must not leak into it.
    assert.ok(!('forAlgo' in b2.blended_ceiling_sats_unit_day));
  });
});

test('hash value reports in the algorithm\'s unit, from the same per-TH data', () => {
  const latest = { lowest: 4e-7, last10: 5e-7 };
  const rentals = [{ rate_btc_th_day: 6e-7, advertised_th: 100, avg_percent: 100 }];
  const ph = market.hashValue(latest, rentals, 'ph');
  const th = market.hashValue(latest, rentals, 'th');
  assert.equal(ph.your_pay_sats_unit_day / th.your_pay_sats_unit_day, 1000);
  assert.equal(ph.price_unit, 'ph');
  assert.equal(th.price_unit, 'th');
  // The verdict is a ratio, so it must not depend on the unit at all.
  assert.equal(ph.over_market_pct, th.over_market_pct);
});

test('every algorithm in the registry has a unit the converter accepts', () => {
  // A new entry with a typo'd or exotic unit would throw deep inside a pricing path
  // rather than here.
  for (const slug of algos.SLUGS) {
    const unit = algos.priceUnit(slug);
    assert.doesNotThrow(() => units.perThFactor(unit), `${slug} unit ${unit}`);
    assert.ok(units.perThFactor(unit) > 0);
  }
});
