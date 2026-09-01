'use strict';
/*
 * Typed configuration over the `config` table (one JSON row per namespace, per
 * algorithm where the namespace is algorithm-specific).
 *
 * Defaults live here so nothing else hard-codes a knob. Only explicit overrides are
 * stored; defaults are merged in on read, so changing a default here propagates to
 * any value the user never touched. The base defaults are tuned for the common
 * sha256ab operating scale (single-digit PH/s, hundreds-of-k to a few-M sats) and are
 * provisional until the live soak; an algorithm whose market has a different shape
 * overlays its own in algos.js rather than restating the whole set.
 */
const algos = require('./algos');

/*
 * Namespaces whose values describe how to spend money in a particular market, and
 * so mean different things per algorithm. Everything else is shared.
 *
 * The split is deliberate in both directions. Sharing `guardrails` would let a
 * ceiling tuned for one market silently govern the other, three orders of magnitude
 * away. Splitting `duckdns` would lose a user their DNS setup on a switch, for no
 * gain, since a hostname has nothing to do with which algorithm is being rented.
 */
const SCOPED_NS = new Set(['strategy', 'guardrails', 'ui']);

// Stored in the algo column for a global namespace. Not a valid slug, so a global
// row can never be read as one algorithm's settings.
const GLOBAL = '';

const DEFAULTS = {
  // Which algorithm this instance rents. Global by definition: it is the thing the
  // scoped namespaces are scoped BY, so scoping it would be circular.
  algorithm: {
    active: algos.DEFAULT_ALGO,
  },
  strategy: {
    min_rpi: 90,                    // reliability floor for eligible rigs
    stability_tolerance_pct: 20,    // max 5/15/30-min variance to count a rig "steady"
    hashrate_tolerance_pct: 5,      // drift below target before autopilot tops up
    rent_pacing_seconds: 60,        // min spacing between rent mutations
    ramp_grace_minutes: 15,         // no under-delivery alarms during ramp-up
    health_debounce_minutes: 10,    // sustained-fresh window before DEGRADED/OFFLINE
    auto_extend: false,             // opt-in
    auto_extend_price_tolerance_pct: 10,  // extend only if the new rate is within this of the original
    fit_tolerance_pct: 20,          // a top-up rig may overshoot the remaining gap by up to this % and still be chosen cheapest-rank-first
    max_overshoot_pct: 50,          // forced-close ceiling: beyond this % overshoot, leave a bounded shortfall and retry next tick rather than over-provision uncancellable capacity
    replace_lead_minutes: 5,        // start renting a rig's replacement this long before it ends (it cliffs at end_ts) to overlap the ~2.5min ramp dead-time; 0 disables the lookahead
    fallback_pool_enabled: true,    // Ocean safety-net at rental priority 1 (same BTC address); engages only if your endpoint drops
    dead_rig_reroute_enabled: true, // reroute a rig that's offline-on-your-pool (while healthy peers mine fine) to Ocean + message its owner; depends on fallback_pool_enabled
    owner_nudge_enabled: false,     // opt-in: message a rig owner when their rig sustains under-delivery (default OFF)
    region_include: [],
    region_exclude: [],
    blacklist_rig_ids: [],
  },
  guardrails: {
    // Hard spend ceilings the quote UI can't exceed; enforced in the gate. Set above
    // the common ~1M-sat range but well below a full balance, as defense in depth.
    max_session_budget_sats: 5000000,
    max_daily_spend_sats: 10000000,
    blended_ceiling_sats_unit_day: null, // primary price cap: max BLENDED pay-rate, sats per <priceUnit>·day; null = off
    rate_ceiling_sats_th_hour: null, // optional per-rig backstop (sats/TH/hr); null = off (auto 2× blend when a blended cap is set)
    deposit_leadtime_hours: 2,      // low-balance early warning vs the 3-conf delay
    refund_watch_days: 14,          // how long an ended rental is watched for refunds
  },
  notifications: {
    telegram_enabled: false,
  },
  ui: {
    hashrate_unit: 'ph',            // primary display unit (PH/s); sub-PH toggles to TH/s
  },
  // DuckDNS: give a raw-IP stratum endpoint a stable DNS name (MRR won't refund IP-pointed rentals).
  // Not in SETTINGS -> surfaced on the endpoint card, not the generic settings list; the token is a
  // secret (secrets table), never here. `ip` is the address the name currently points at.
  duckdns: {
    enabled: false,
    subdomain: null,
    ip: null,
    updated_at: null,             // unix secs of the last successful DuckDNS push (drives the daily keepalive)
  },
};

function nowSeconds() { return Math.floor(Date.now() / 1000); }

/** Read one namespace's stored overrides. `algo` is already resolved. */
function storedFor(conn, ns, algo) {
  const row = conn.prepare('SELECT json FROM config WHERE ns = ? AND algo = ?').get(ns, algo);
  if (!row) return {};
  // A corrupt row must not take the process down on a read, and must not read as
  // "no overrides" either, since that would silently restore defaults on a namespace
  // the user had deliberately tightened. Failing here is the honest option.
  return JSON.parse(row.json);
}

/**
 * The algorithm this instance is renting.
 *
 * Lives here, not in market.js, because the config layer needs it to resolve a
 * scoped namespace and market.js already reads config. Putting it the other way
 * round is a require cycle. market.activeAlgo re-exports this for the call sites
 * that think of it as a market question.
 *
 * Reads only a global namespace, so it cannot recurse back into itself. An
 * unrecognised stored slug falls back to the default rather than throwing: this is
 * on the path of every read and every write, and a bad config row should not be
 * able to stop the app from starting.
 */
function activeAlgo(conn) {
  const stored = storedFor(conn, 'algorithm', GLOBAL);
  const slug = stored.active;
  return algos.isKnown(slug) ? slug : algos.DEFAULT_ALGO;
}

/** Which algo column a namespace lives under, resolving the active one if needed. */
function algoFor(conn, ns, algo) {
  if (!SCOPED_NS.has(ns)) return GLOBAL;
  return algo || activeAlgo(conn);
}

/**
 * Effective config for a namespace: base defaults, then the algorithm's own
 * defaults, then stored overrides.
 *
 * `algo` is optional and only meaningful for a scoped namespace; it exists so the
 * settings UI can show one algorithm's values while another is active, and so a
 * switch can validate the incoming algorithm's config before committing to it.
 */
function get(conn, ns, algo) {
  const scope = algoFor(conn, ns, algo);
  const stored = storedFor(conn, ns, scope);
  // A stored null/undefined must NOT mask a non-null default — otherwise a corrupt config could
  // null out a hard spend ceiling and the gate would read it as "no cap" (fail-open). Keys whose
  // default is intentionally null (e.g. an optional rate ceiling) resolve to null either way.
  const clean = {};
  for (const [k, v] of Object.entries(stored)) if (v != null) clean[k] = v;
  const base = DEFAULTS[ns] || {};
  const perAlgo = scope === GLOBAL ? {} : algos.defaultsFor(scope, ns);
  return { ...base, ...perAlgo, ...clean };
}

function getKey(conn, ns, key, algo) {
  return get(conn, ns, algo)[key];
}

/** Merge `patch` into the stored overrides for `ns` (defaults are never persisted). */
function set(conn, ns, patch, algo) {
  const scope = algoFor(conn, ns, algo);
  const stored = storedFor(conn, ns, scope);
  const overrides = { ...stored, ...patch };
  conn.prepare(
    `INSERT INTO config (ns, algo, json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ns, algo) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(ns, scope, JSON.stringify(overrides), nowSeconds());
  return get(conn, ns, algo);
}

/** Every namespace's effective config for the active algorithm (the canonical knob list). */
function all(conn) {
  const out = {};
  for (const ns of Object.keys(DEFAULTS)) out[ns] = get(conn, ns);
  return out;
}

/*
 * User-settable knobs (the Settings page + POST /api/config). Only these namespaces/keys are
 * readable and writable via the config API — run/mrr/setup and anything secret are deliberately
 * excluded, so a settings GET can never leak credentials. `label`/`unit` drive the UI; the type +
 * bounds are enforced server-side. (blacklist_rig_ids is managed from the rig scorecard, not here.)
 */
const SETTINGS = {
  strategy: {
    min_rpi: { type: 'int', min: 0, max: 100, label: 'Minimum RPI', help: 'Reliability floor a rig must meet to be eligible.' },
    hashrate_tolerance_pct: { type: 'int', min: 0, max: 50, unit: '%', label: 'Hashrate tolerance', help: 'How far below target autopilot drifts before topping up.' },
    stability_tolerance_pct: { type: 'int', min: 0, max: 100, unit: '%', label: 'Stability tolerance', help: 'Max short-window variance for a rig to count as steady.' },
    rent_pacing_seconds: { type: 'int', min: 0, max: 3600, unit: 's', label: 'Rent pacing', help: 'Minimum spacing between rent/extend mutations.' },
    ramp_grace_minutes: { type: 'int', min: 0, max: 120, unit: 'min', label: 'Ramp grace', help: 'No under-delivery alarms during a fresh rig ramp-up.' },
    health_debounce_minutes: { type: 'int', min: 1, max: 120, unit: 'min', label: 'Health debounce', help: 'Sustained-fresh window before a rig flips degraded/offline.' },
    auto_extend: { type: 'bool', label: 'Auto-extend', help: 'Extend a healthy near-end rental in place when the rate holds.' },
    auto_extend_price_tolerance_pct: { type: 'int', min: 0, max: 200, unit: '%', label: 'Auto-extend price tolerance', help: 'Only extend if the new rate is within this of the original.' },
    fit_tolerance_pct: { type: 'int', min: 0, max: 500, unit: '%', label: 'Fit tolerance', help: 'A top-up rig may overshoot the gap by up to this and stay cheapest-first.' },
    max_overshoot_pct: { type: 'int', min: 0, max: 2000, unit: '%', label: 'Max overshoot', help: 'Beyond this overshoot, hold a shortfall and retry rather than over-provision.' },
    replace_lead_minutes: { type: 'int', min: 0, max: 60, unit: 'min', label: 'Replace lead', help: 'Rent a replacement this long before a rig ends (0 disables the lookahead).' },
    fallback_pool_enabled: {
      type: 'bool', label: 'Fallback pool',
      help: 'If your endpoint becomes unreachable, rented hashrate fails over to a backup pool, mining to your same Bitcoin address instead of being wasted. Your node stays primary — the fallback only engages on failure.',
      forAlgo: (a) => (a.fallbackPool
        ? {
          label: `Fallback pool (${a.fallbackPool.name})`,
          help: `If your endpoint becomes unreachable, rented hashrate fails over to ${a.fallbackPool.name}, mining to your same Bitcoin address instead of being wasted. Your node stays primary — ${a.fallbackPool.name} only engages on failure.`,
        }
        : {
          // Marked unavailable rather than quietly hidden. It is on by default for the
          // other algorithm, so a user who knows that deserves to be told why it is not
          // here, instead of wondering whether their rentals have a safety net.
          unavailable: true,
          help: `No fallback pool accepts ${a.short} work. Failover would route rented hashrate to a pool that cannot mine it — still billing, producing nothing, at the moment your endpoint has already failed. Unavailable for this algorithm.`,
        }),
    },
    dead_rig_reroute_enabled: {
      type: 'bool', label: 'Reroute dead rigs', dependsOn: 'fallback_pool_enabled',
      help: 'When a rented rig connects but never mines on your pool (offline ~10 min while your OTHER rented rigs are mining fine on the same pool), switch just that rental to the fallback pool and message its owner. Targets only the stuck rig; the rest keep mining to your node.',
      forAlgo: (a) => (a.fallbackPool
        ? {
          label: `Reroute dead rigs to ${a.fallbackPool.name}`,
          help: `When a rented rig connects but never mines on your pool (offline ~10 min while your OTHER rented rigs are mining fine on the same pool), switch just that rental to the ${a.fallbackPool.name} fallback and message its owner. Targets only the stuck rig; the rest keep mining to your node. On by default. Extends the Fallback pool — turns off with it.`,
        }
        : { unavailable: true, help: `Depends on the fallback pool, which no ${a.short} pool provides. Unavailable for this algorithm.` }),
    },
    owner_nudge_enabled: { type: 'bool', label: 'Nudge under-delivering owners', help: 'Automatically message a rig owner (once) when their rig sustains under-delivery. Off by default.' },
    region_include: { type: 'strlist', label: 'Region include', help: 'Comma-separated regions to restrict to (empty = any).' },
    region_exclude: { type: 'strlist', label: 'Region exclude', help: 'Comma-separated regions to avoid.' },
  },
  guardrails: {
    max_session_budget_sats: { type: 'int', min: 0, max: 1e12, unit: 'sats', label: 'Max session budget', help: 'Hard ceiling on any one session’s spend.' },
    max_daily_spend_sats: { type: 'int', min: 0, max: 1e12, unit: 'sats', label: 'Max daily spend', help: 'Rolling 24h spend ceiling across all sessions.' },
    blended_ceiling_sats_unit_day: {
      type: 'floatOrNull', min: 0, unit: 'sats/PH·day', label: 'Blended rate ceiling',
      help: 'Cap on your overall blended pay-rate — the "you" line on the market chart (blank = off). Autopilot fills the target with the cheapest rigs while keeping the average under this; it leaves a shortfall rather than overpaying. Set it in the Autopilot preview per session, or here as a standing default.',
      // The unit is the algorithm's, not a fixed PH. Showing "sats/PH·day" beside a
      // blake2b field would invite a number a thousand times too small.
      forAlgo: (a) => ({ unit: `sats/${a.priceUnit.toUpperCase()}·day` }),
    },
    rate_ceiling_sats_th_hour: {
      type: 'floatOrNull', min: 0, unit: 'sats/TH/hr', label: 'Per-rig backstop',
      help: 'Optional hard cap on any SINGLE rig’s price (sats per TH per hour; blank = off). A backstop for the blended ceiling so no one rig is absurdly priced even when cheap rigs dilute the average. When a blended ceiling is set, a 2× auto-backstop already applies.',
      // Always per TH/hr, so the unit does not move — but the number a user should
      // have in mind moves by a factor of 2,425, which is the whole point of saying it.
      forAlgo: (a) => ({
        help: `Optional hard cap on any SINGLE rig’s price (sats per TH per hour; blank = off). A backstop for the blended ceiling so no one rig is absurdly priced even when cheap rigs dilute the average. When a blended ceiling is set, a 2× auto-backstop already applies. A recent ${a.short} rig runs ~${a.typicalSatsThHour} sats/TH/hr.`,
      }),
    },
    deposit_leadtime_hours: { type: 'number', min: 0, max: 168, unit: 'h', label: 'Low-balance lead time', help: 'Warn when runway drops under this.' },
    refund_watch_days: { type: 'int', min: 0, max: 90, unit: 'days', label: 'Refund watch', help: 'How long an ended rental is watched for refunds.' },
  },
  // notifications (Telegram) is DEFERRED to a future release — intentionally omitted from
  // the settable schema so no half-built card shows. The DEFAULTS.notifications placeholder stays.
  ui: {
    hashrate_unit: { type: 'enum', values: ['ph', 'th'], label: 'Hashrate unit', help: 'Primary display unit.' },
  },
};

/**
 * The settings schema as the active algorithm sees it.
 *
 * Same keys and same bounds as SETTINGS — only the human-facing unit and help move,
 * because a price knob labelled in the wrong unit is worse than one with no label.
 * Validation stays on the static schema, since nothing about the bounds is
 * algorithm-specific.
 */
function settings(conn) {
  const entry = algos.get(activeAlgo(conn));
  const out = {};
  for (const [ns, specs] of Object.entries(SETTINGS)) {
    out[ns] = {};
    for (const [key, spec] of Object.entries(specs)) {
      const { forAlgo, ...rest } = spec;
      out[ns][key] = forAlgo ? { ...rest, ...forAlgo(entry) } : rest;
    }
  }
  return out;
}

/** Coerce + bounds-check one raw value against its spec. Returns {ok, value} or {ok:false, reason}. */
function coerce(spec, raw) {
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true' || raw === 1 || raw === '1') return { ok: true, value: true };
    if (raw === 'false' || raw === 0 || raw === '0') return { ok: true, value: false };
    return { ok: false, reason: 'expected a boolean' };
  }
  if (spec.type === 'enum') return spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false, reason: `must be one of ${spec.values.join(', ')}` };
  if (spec.type === 'strlist') {
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : null);
    if (!arr) return { ok: false, reason: 'expected a list' };
    return { ok: true, value: arr.map((s) => String(s).trim()).filter(Boolean) };
  }
  if (spec.type === 'floatOrNull' && (raw === null || raw === '' || raw === undefined)) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: 'expected a number' };
  if (spec.type === 'int' && !Number.isInteger(n)) return { ok: false, reason: 'expected a whole number' };
  if (spec.min != null && n < spec.min) return { ok: false, reason: `must be ≥ ${spec.min}` };
  if (spec.max != null && n > spec.max) return { ok: false, reason: `must be ≤ ${spec.max}` };
  return { ok: true, value: n };
}

/** Validate a patch of settings for one namespace. Returns {ok, patch} or {ok:false, field, reason}. */
function validatePatch(ns, patch) {
  const specs = SETTINGS[ns];
  if (!specs) return { ok: false, field: null, reason: 'unknown namespace' };
  const out = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    // hasOwn, not `specs[key]` — otherwise inherited prototype keys (__proto__, constructor,
    // toString, …) resolve truthy and slip past as "known" settings.
    if (!Object.hasOwn(specs, key)) return { ok: false, field: key, reason: 'unknown setting' };
    const spec = specs[key];
    const c = coerce(spec, raw);
    if (!c.ok) return { ok: false, field: key, reason: c.reason };
    out[key] = c.value;
  }
  return { ok: true, patch: out };
}

module.exports = {
  DEFAULTS, get, getKey, set, all, SETTINGS, settings, validatePatch,
  activeAlgo, SCOPED_NS, GLOBAL,
};
