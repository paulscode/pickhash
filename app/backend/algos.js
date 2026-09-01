'use strict';
/*
 * The algorithms this app can rent, and everything that differs between them.
 *
 * One registry rather than conditionals spread through the code: adding a third
 * algorithm should be an entry here, not a search for every place two of them were
 * assumed. The slugs are the rental API's own, so they are also what gets stamped
 * into the `algo` column and what goes on the wire.
 *
 * The two supported algorithms are not variations on a theme. Measured from the
 * live API on 2026-08-30 (the fixtures in test/fixtures/mrr/algo-*.json):
 *
 *                         sha256ab              blake2b
 *   suggested price       52,820 sats/PH·day    128,100 sats/TH·day
 *   the same, per TH/hr   2.2                   5,337.5        (2,425x)
 *   available hashrate    36,674 PH             136 TH         (269,000x)
 *
 * Nothing about those two columns is comparable, which is why the database keeps
 * them apart and why the price knobs below are per-algorithm. A ceiling that is
 * merely generous on one is unreachable or unlimited on the other.
 */

/*
 * `priceUnit` is the unit the API quotes in, and therefore the unit the user
 * enters a price ceiling in. It is not cosmetic: sha256ab is quoted per PH and
 * blake2b per TH, so the same number means a thousandfold different price. Every
 * conversion to the internal per-TH representation goes through this.
 *
 * `defaults` overlays the base defaults in config.js for this algorithm, and only
 * needs to name the knobs that actually differ.
 */
const ALGOS = {
  sha256ab: {
    slug: 'sha256ab',
    /* The API's own display name. Shown verbatim so what the app calls the
     * algorithm matches what the marketplace calls it. */
    display: 'SHA256 Asicboost',
    /* How the app refers to it in its own UI, where the marketplace's name is
     * more than is needed. */
    short: 'SHA256',
    priceUnit: 'ph',
    /* Roughly what a current rig costs, for the help text on the per-rig
     * backstop. A user with no feel for the market needs an anchor to set it
     * against, and the anchor is different by three orders of magnitude. */
    typicalSatsThHour: 2.2,
    /*
     * The safety-net pool a rental falls back to if the user's own endpoint drops.
     *
     * Ocean runs real vardiff, so a rig starved by an endpoint difficulty mismatch
     * still hashes, and it pays to the same Bitcoin address, so failover still earns.
     * It also means the marketplace cannot deny a refund for "no backup pool".
     */
    fallbackPool: { host: 'bip110.mine.ocean.xyz', port: 3110, name: 'Ocean' },
    defaults: {},
  },
  blake2b: {
    slug: 'blake2b',
    display: 'Blake2B Siacoin',
    short: 'BLAKE2b',
    priceUnit: 'th',
    typicalSatsThHour: 5337.5,
    /*
     * No fallback pool. There is no public BLAKE2b pool that accepts arbitrary
     * hashrate and pays to a Bitcoin address the way Ocean does for SHA256.
     *
     * This is null rather than left to inherit, because inheriting Ocean is exactly
     * the failure. Ocean cannot accept BLAKE2b work: the rental would keep costing
     * money and produce nothing, and it engages precisely when something has already
     * gone wrong, so nobody is watching the right thing. The rental still runs on the
     * user's own endpoint; it just has no second pool behind it.
     */
    fallbackPool: null,
    /*
     * The spend ceilings are absolute sats, so they do not rescale with the price
     * of hashrate on their own, and left alone they stop binding. The sha256ab
     * defaults allow about 95 PH·day at the suggested price, against 36,674 PH
     * available: a small fraction of the market. Carried onto blake2b unchanged,
     * 5,000,000 sats buys about 39 TH·day out of 136 TH available, so a single
     * session could take a third of the entire market before a guardrail spoke.
     *
     * These bring it back to a comparable share: 2,000,000 sats is about 15.6
     * TH·day, near a tenth of what is available. Provisional, like the sha256ab
     * numbers they are derived from, and deliberately loose enough not to block an
     * ordinary session while still being a ceiling.
     */
    defaults: {
      guardrails: {
        max_session_budget_sats: 2000000,
        max_daily_spend_sats: 4000000,
      },
      /* PH is the wrong primary unit for a market whose entire available supply is
       * around 136 TH: every reading would be a small fraction with the interesting
       * digits pushed off the end. */
      ui: {
        hashrate_unit: 'th',
      },
      /* Both default to true for sha256ab, and both route hashrate to the fallback
       * pool. With no fallback pool to route to they can only ever be no-ops, so they
       * default off and the settings page says why rather than offering a switch that
       * does nothing. */
      strategy: {
        fallback_pool_enabled: false,
        dead_rig_reroute_enabled: false,
        /* The Companion exposes the BLAKE2b Datum Gateway; the ordinary HashGG
         * exposes whichever app holds the official Datum slot. This is the default
         * pairing rather than a rule, because the ordinary HashGG follows whatever
         * chain its gateway is built for and a user may have that on BLAKE2b. The
         * setting is per-algorithm, so each remembers its own answer. */
        hashgg_source: 'companion',
      },
    },
  },
};

const DEFAULT_ALGO = 'sha256ab';

/** Every known slug, in a stable order (the default first). */
const SLUGS = Object.keys(ALGOS);

function isKnown(slug) {
  return Object.hasOwn(ALGOS, String(slug));
}

/**
 * The registry entry for a slug.
 *
 * Falls back to the default rather than throwing. A slug reaches here from the
 * database or a config row, and an unrecognised one should degrade to the
 * long-standing behaviour rather than take the process down on a read.
 */
function get(slug) {
  return isKnown(slug) ? ALGOS[slug] : ALGOS[DEFAULT_ALGO];
}

/** The unit the algorithm's prices are quoted and entered in ('ph' or 'th'). */
function priceUnit(slug) {
  return get(slug).priceUnit;
}

/** The algorithm's per-namespace default overrides (`{}` when it has none). */
function defaultsFor(slug, ns) {
  return get(slug).defaults[ns] || {};
}

/**
 * The algorithm's fallback pool, or null if it has none.
 *
 * Callers pass the result of this around rather than a boolean, so that "fallback is
 * enabled" can never be mistaken for "route to Ocean". An algorithm Ocean cannot
 * serve has nothing to be enabled.
 */
function fallbackPool(slug) {
  return get(slug).fallbackPool || null;
}

module.exports = { ALGOS, SLUGS, DEFAULT_ALGO, isKnown, get, priceUnit, defaultsFor, fallbackPool };
