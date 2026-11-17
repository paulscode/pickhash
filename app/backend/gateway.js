'use strict';
/*
 * Does the stratum endpoint's Datum Gateway support serving rented rigs below the pool's
 * minimum difficulty, and if not, where does the user get one that does?
 *
 * Why it matters. A Datum Gateway raises every miner to the pool's minimum difficulty, and
 * a pool like CONVOY sizes that minimum to the gateway's TOTAL hashrate. Behind a busy
 * gateway each rented rig is then asked for a difficulty sized for the whole fleet: it finds
 * a share every few minutes, MRR's hashrate reading for it turns choppy, the rig owner gets a
 * "High Worker Difficulty" warning, and MRR's proxy drops and reconnects the pool roughly two
 * minutes after each accepted share. PaulsCode's Datum Gateway builds can instead serve each
 * rig a difficulty that suits it while still committing the work at the pool's minimum, so
 * the pool's credit is unchanged (stratum.vardiff_below_pool_min).
 *
 * Those builds answer a `datum.capabilities` request (stratum.capabilities()); any other
 * Gateway answers "Method not found". Pure: no I/O here.
 */

const REGISTRY_URL = 'https://start9.paulscode.com';
const UMBREL_STORE_URL = 'https://github.com/paulscode/umbrel-store';

/** 'startos' | 'umbrel' | null. Set by the package; otherwise inferred from the HashGG address it passes. */
function platform(env = process.env) {
  const p = String(env.PICKHASH_PLATFORM || '').toLowerCase();
  if (p === 'startos' || p === 'umbrel') return p;
  const hg = String(env.HASHGG_HOST || '');
  if (hg.endsWith('.startos') || hg.endsWith('.embassy')) return 'startos';
  if (hg.startsWith('paulscode-')) return 'umbrel';
  return null;
}

/** The app to install for this algorithm, by the name each platform's store lists it under. */
function recommendedApp(algo, plat) {
  const chain = algo === 'blake2b' ? 'BLAKE2b' : 'SHA256';
  return plat === 'umbrel' ? `Datum (${chain})` : `Datum Gateway (${chain})`;
}

function storeFor(plat) {
  if (plat === 'umbrel') {
    return { name: 'PaulsCode.Com community app store', url: UMBREL_STORE_URL, how: 'App Store → ⋯ → Community App Stores → add' };
  }
  if (plat === 'startos') {
    return { name: 'PaulsCode registry', url: REGISTRY_URL, how: 'Marketplace → add registry' };
  }
  return { name: 'PaulsCode registry (StartOS) or community app store (Umbrel)', url: REGISTRY_URL, how: null };
}

/**
 * Assess a capabilities() result.
 * @returns {{status, gateway, poolMinDiff, app, store}}
 *   status:
 *     'ready'    the Gateway serves rigs below the pool minimum, and it is switched on
 *     'disabled' supported but switched off in the Gateway's settings
 *     'outdated' the Gateway does not support it (an older or stock Datum Gateway)
 *     'unknown'  no answer, so nothing is known (unreachable or timed out); never warned about
 */
function assess(capsResult, { algo, platform: plat } = {}) {
  const r = capsResult || {};
  const caps = r.supported ? (r.caps || {}) : null;
  const feats = (caps && caps.features && typeof caps.features === 'object') ? caps.features : {};
  let status;
  if (r.supported == null) status = 'unknown';
  else if (!r.supported || !('vardiff_below_pool_min' in feats)) status = 'outdated';
  else status = feats.vardiff_below_pool_min === true ? 'ready' : 'disabled';
  const minDiff = caps && Number.isFinite(Number(caps.pool_min_diff)) ? Number(caps.pool_min_diff) : null;
  return {
    status,
    gateway: caps && typeof caps.gateway === 'string' ? caps.gateway.slice(0, 80) : null,
    poolMinDiff: minDiff && minDiff > 0 ? minDiff : null,
    app: recommendedApp(algo, plat),
    store: storeFor(plat),
  };
}

/** True when the assessment is worth a standing warning. */
function needsAttention(a) {
  return !!a && (a.status === 'outdated' || a.status === 'disabled');
}

module.exports = { platform, recommendedApp, storeFor, assess, needsAttention, REGISTRY_URL, UMBREL_STORE_URL };
