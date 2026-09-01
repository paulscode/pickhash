'use strict';
/*
 * When autopilot cannot cover a target, it has to say why.
 *
 * Reported from the field: "the market can only cover 0 TH/s" while the marketplace
 * listed multiple rigs. Both were true. Autopilot is stricter than a quick rent and
 * passes over anything without a settled delivery history, anything whose pool is
 * offline, and anything too variable. On a young market that is most of what is
 * listed, so a message that mentions only the shortfall reads as the app being broken.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const quote = require('../quote');
const market = require('../market');

// fetchAllRigs hands the estimator normalized rigs, so the eligibility rules see that
// shape and the fixtures have to go through the same door.
const norm = (raw) => market.normalizeRig(raw);

/** A raw rig in the shape the marketplace returns. */
function rawRig(id, over = {}) {
  return {
    id, name: `rig-${id}`, owner: 'o', region: 'us-east', rpi: '96.0',
    status: { status: 'available', rented: false, online: true }, online: true,
    poolstatus: 'online', available_status: 'available',
    optimal_diff: { min: '1000', max: '2000000' }, extensions: true,
    minhours: '3', maxhours: '96',
    price: { type: 'th', BTC: { currency: 'BTC', price: '0.00292545', hour: '0.0001', min_rental_length: 3, enabled: true } },
    hashrate: {
      advertised: { hash: '3', type: 'th' },
      last_5min: { hash: '3000000', type: 'mh' },
      last_15min: { hash: '3000000', type: 'mh' },
      last_30min: { hash: '3000000', type: 'mh' },
    },
    ...over,
  };
}

const OPTS = { mode: 'autopilot', minRpi: 90, blacklist: [], stabilityTolerancePct: 20 };

function tally(rigs) {
  const passedOver = {};
  for (const raw of rigs) {
    const e = quote.eligibility(quote.derive(norm(raw), OPTS), OPTS);
    if (e.ok) continue;
    for (const r of e.reasons) passedOver[r] = (passedOver[r] || 0) + 1;
  }
  return passedOver;
}

test('a rig with no delivery history is passed over by autopilot, and says so', () => {
  // A freshly listed rig has no short-window measurements. That is the ordinary case on
  // a market only days old, and the single biggest reason a target cannot be covered.
  const fresh = rawRig('1', {
    hashrate: { advertised: { hash: '3', type: 'th' } },
  });
  const e = quote.eligibility(quote.derive(norm(fresh), OPTS), OPTS);
  assert.equal(e.ok, false);
  assert.ok(e.reasons.includes('no_stability_data'), e.reasons.join(','));

  // The same rig is fine for a quick rent, which is the asymmetry the message has to
  // explain: the marketplace lists it, and one path here will use it.
  const quick = quote.eligibility(quote.derive(norm(fresh), { ...OPTS, mode: 'quick' }), { ...OPTS, mode: 'quick' });
  assert.equal(quick.ok, true, 'a quick rent accepts what autopilot will not');
});

test('the tally names the dominant reason, so the message can be specific', () => {
  const rigs = [
    rawRig('1', { hashrate: { advertised: { hash: '3', type: 'th' } } }),
    rawRig('2', { hashrate: { advertised: { hash: '3', type: 'th' } } }),
    rawRig('3', { poolstatus: 'offline' }),
    rawRig('4'),
  ];
  const over = tally(rigs);
  const ranked = Object.entries(over).sort((a, b) => b[1] - a[1]);
  assert.equal(ranked[0][0], 'no_stability_data');
  assert.equal(ranked[0][1], 2, 'two rigs with no history');
  assert.equal(over.pool_offline, 1);
  assert.equal(quote.candidates(rigs.map(norm), OPTS).length, 1, 'one rig survives');
});

test('a market where nothing was passed over reports nothing', () => {
  // Then the market really is that small, and the plain wording is the honest one.
  assert.deepEqual(tally([rawRig('1'), rawRig('2')]), {});
});
