'use strict';
/*
 * observe() — the only stage with side effects reading in. It gathers the
 * live world into one immutable snapshot that decide()/alerts/persist consume, and it
 * advances each active rental's health.
 *
 * Discipline:
 *   - Every fetch is blip-safe: on failure we set a `fetch_ok:false` flag and HOLD the
 *     previous values rather than treating a failed list fetch as "we own nothing"
 *     (the duplicate-order trap). Health never advances on a non-fresh reading.
 *   - Reconciliation: MRR's active-rentals list is matched against our DB. An untracked
 *     rental that matches a pending-intent (our rig + create-time window) is adopted
 *     exactly once (recovers an ambiguous create); one we can't attribute raises a review
 *     alert rather than being silently adopted or re-rented.
 *
 * The pure cores (reconcile, mergeRental) are exported for testing; the impure observe()
 * orchestrates the I/O around them.
 */
const market = require('../market');
const units = require('../units');
const deposit = require('../deposit');
const stratum = require('../stratum');
const endpointUtil = require('../endpoint');
const hashgg = require('../hashgg');
const config = require('../config');
const health = require('./health');
const delivery = require('./delivery');
const refunds = require('./refunds');
const dispute = require('./dispute');
const prune = require('./prune');
const scoring = require('./scoring');
const endpoints = require('../endpoints');
const gatewayCaps = require('../gateway');

const MARKET_CADENCE_MS = 5 * 60 * 1000;   // market snapshot every 5 min, not every tick
const GATEWAY_CADENCE_MS = 30 * 60 * 1000; // re-ask the Gateway what it supports every 30 min
const GATEWAY_TIMEOUT_MS = 4000;           // ...and give it this long to answer
const GATEWAY_STALE_SEC = 24 * 60 * 60;    // a last-known answer older than this is dropped
const ADOPT_WINDOW_SEC = 15 * 60;          // a rental starting within 15 min of an intent

function num(v) { return v === '' || v === null || v === undefined ? null : Number(v); }

/**
 * Match MRR's active-rentals list against what we already track. Pure.
 * @param {object} a
 * @param {Array<string|number>} a.trackedMrrIds  mrr_ids we already have rentals rows for
 * @param {Array} a.mrrList   MRR active rentals ({id, rig:{id}|rigid, start_unix})
 * @param {Array} a.intents   pending intents ({id, rig, ts}) from decisions rows
 * @param {number} a.windowSec
 * @returns {{adopt:Array<{mrrId,intentId,rigId}>, unattributable:Array<{mrrId,rigId}>}}
 */
function reconcile({ trackedMrrIds, mrrList, intents, windowSec = ADOPT_WINDOW_SEC }) {
  const known = new Set((trackedMrrIds || []).map(String));
  const usedIntent = new Set();
  const adopt = [];
  const unattributable = [];
  for (const m of mrrList || []) {
    const mid = String(m.id);
    if (known.has(mid)) continue;
    const rigId = num(m.rig && m.rig.id != null ? m.rig.id : m.rigid);
    const startUnix = num(m.start_unix != null ? m.start_unix : m.start_ts) || 0;
    // A pending intent for the same rig whose create-time window brackets this start.
    const match = (intents || []).find((it) => !usedIntent.has(it.id)
      && num(it.rig) === rigId
      && startUnix >= it.ts - 60 && startUnix <= it.ts + windowSec);
    if (match) { usedIntent.add(match.id); adopt.push({ mrrId: mid, intentId: match.id, rigId }); }
    else unattributable.push({ mrrId: mid, rigId });
  }
  return { adopt, unattributable };
}

/**
 * Advance one tracked rental's delivery + health for this tick. Pure.
 * @param {object} rental   our rentals row
 * @param {object|null} detail  MRR rental detail (null on a blip)
 * @param {object} prevHealth   previous health record (health.initial() shape)
 * @param {number|null} prevPercent
 * @param {number} nowMs
 * @param {boolean} fetchOk  did the rentals fetch succeed this tick
 */
function mergeRental(rental, detail, prevHealth, prevPercent, nowMs) {
  const ended = !!(detail && (detail.ended === true || detail.ended === 'true'))
    || (rental.end_ts != null && nowMs / 1000 >= rental.end_ts);
  const sig = delivery.resolveSignal({
    detail,
    advertisedTh: rental.advertised_th,
    prevPercent,
    now: Math.floor(nowMs / 1000),
  });
  const h = health.step(prevHealth, { percent: sig.authoritative, source: sig.source, fresh: sig.fresh, ended, now: nowMs });
  return { signal: sig, health: h, ended };
}

/**
 * Full observe. Returns { snapshot, nextState }. `prevState` carries per-rental health
 * records + last percents + last market fetch time between ticks (the loop owns it).
 */
async function observe(conn, client, ctx = {}) {
  const nowMs = ctx.now != null ? ctx.now : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const prev = ctx.prevState || { rentals: {}, marketAt: 0, market: null };
  const dataDir = ctx.dataDir;
  const fetchOk = { rentals: true, balance: true, market: true, endpoint: true, hashgg: true };

  const session = conn.prepare("SELECT * FROM sessions WHERE state IN ('active', 'winding_down') ORDER BY id DESC LIMIT 1").get() || null;
  const tracked = session
    ? conn.prepare('SELECT * FROM rentals WHERE session_id = ? AND ended = 0').all(session.id)
    : [];

  // --- Active rentals list (blip-safe) ---
  let mrrList = null;
  try { const r = await client.get('/rental', { type: 'renter', history: false, limit: 100 }); mrrList = (r && r.records) || []; }
  catch { fetchOk.rentals = false; }

  // --- Per-rental detail + health ---
  const nextRentals = {};
  const rentalsOut = [];
  for (const rental of tracked) {
    let detail = null;
    if (fetchOk.rentals) {
      try { detail = await client.get('/rental/' + rental.mrr_id); }
      catch { /* individual detail blip: treat as no fresh reading */ }
    }
    const prevH = (prev.rentals[rental.mrr_id] && prev.rentals[rental.mrr_id].health)
      || health.initial((rental.start_ts || nowSec) * 1000);
    const prevPercent = prev.rentals[rental.mrr_id] ? prev.rentals[rental.mrr_id].percent : undefined;
    const { signal, health: h, ended } = mergeRental(rental, detail, prevH, prevPercent, nowMs);

    // Persist a per-tick sample (only when we have a fresh reading, so stale rows don't
    // pollute the delivered-hashrate chart).
    if (signal.fresh) {
      conn.prepare('INSERT OR REPLACE INTO rental_samples (algo, rental_id, ts, delivered_th, percent, health) VALUES (?, ?, ?, ?, ?, ?)')
        .run(market.activeAlgo(conn), rental.mrr_id, nowSec, signal.deliveredTh, signal.authoritative, h.state);
    }
    // Refresh end_ts to MRR's ACTUAL end once the rental has ended, so the 12h dispute
    // deadline and the refund-watch window anchor to the real end — not the scheduled end
    // captured at create (a rental that terminates early/late would otherwise show, and
    // file against, the wrong window). Only when a real detail reports it (an end detected
    // via the time fallback with no detail leaves the stored end_ts untouched).
    // Only trust MRR's end_unix when the DETAIL itself reports ended (not our time-fallback)
    // and it's a plausible positive timestamp: MRR uses 0/"" as a "not finalized" sentinel
    // and Number('') === 0, which would otherwise clobber end_ts with 0 and break the dispute
    // deadline, refund watch, and evidence-capture window for a legitimately-ended rental.
    const detailEnded = !!(detail && (detail.ended === true || detail.ended === 'true'));
    const endUnix = detailEnded && detail.end_unix != null && Number(detail.end_unix) > 0 ? Number(detail.end_unix) : null;
    const endTs = endUnix != null ? endUnix : rental.end_ts;
    // Persist health + final avg on the rentals row when it changes.
    if (h.state !== rental.health || (signal.authoritative != null && signal.authoritative !== rental.avg_percent) || ended || endTs !== rental.end_ts) {
      conn.prepare('UPDATE rentals SET health = ?, avg_percent = ?, ended = ?, end_ts = ? WHERE mrr_id = ?')
        .run(h.state, signal.authoritative != null ? signal.authoritative : rental.avg_percent, ended ? 1 : 0, endTs, rental.mrr_id);
    }
    // Fold this rig's realized delivery into its score the tick it ENDS (tracked filters ended=0,
    // so a rental is only ever seen ending once). Best-effort — scoring must never break observe.
    if (ended) {
      try { scoring.recordRentalScore(conn, rental, signal.authoritative != null ? signal.authoritative : rental.avg_percent, nowSec); }
      catch { /* ignore */ }
    }

    // On a per-rental detail BLIP (list fetch fine, this rental's detail failed) the raw signal is
    // null — but fetch_ok.rentals stays true, so decide() still runs. Publishing null delivered_th
    // would collapse a CONFIRMED degraded/offline rig's contribution to 0 (contributionTh uses the
    // measured value for those) and trigger a spurious top-up to replace capacity that's actually
    // present. HOLD the last measured percent (as nextState already does) and derive held
    // delivered_th from it, so a blip never moves a spend decision.
    const heldPercent = signal.authoritative != null ? signal.authoritative : (prevPercent != null ? prevPercent : null);
    const heldDeliveredTh = signal.deliveredTh != null
      ? signal.deliveredTh
      : (heldPercent != null && rental.advertised_th != null ? rental.advertised_th * (heldPercent / 100) : null);
    nextRentals[rental.mrr_id] = { health: h, percent: heldPercent };
    rentalsOut.push({
      mrr_id: rental.mrr_id, rig_id: rental.rig_id, rig_name: rental.rig_name, region: rental.region,
      advertised_th: rental.advertised_th, worker_name: rental.worker_name,
      // paid_sats/fee_sats feed the balance_low burn-rate alert — omitting them made burn
      // read as 0 and the runway alert never fired.
      paid_sats: rental.paid_sats, fee_sats: rental.fee_sats,
      length_hours: rental.length_hours, start_ts: rental.start_ts, end_ts: endTs,
      ended, percent: heldPercent, delivered_th: heldDeliveredTh,
      source: signal.source, fresh: signal.fresh, health: h.state,
    });
  }

  // --- Dispute-evidence capture (blip-safe, retries) ---
  // Any recently-ended rental still missing evidence gets its graph + FINAL detail
  // snapshotted before MRR prunes it. Requires a real detail (so a blip that only knows
  // `ended` via end_ts can't lock in a null percent); retries next tick until it succeeds.
  if (fetchOk.rentals) {
    const needEvidence = conn.prepare(
      'SELECT * FROM rentals WHERE ended = 1 AND evidence_json IS NULL AND end_ts IS NOT NULL AND end_ts >= ?',
    ).all(nowSec - 7 * 86400);
    for (const r of needEvidence) {
      let d = null;
      try { d = await client.get(`/rental/${r.mrr_id}`); } catch { continue; }   // no detail -> retry next tick
      let g = null;
      try { g = await client.get(`/rental/${r.mrr_id}/graph`); } catch { /* graph optional (may be pruned) */ }
      // Capture once the detail is in hand — the final % is locked in even if the graph is
      // gone, so this stops retrying rather than hammering MRR for a pruned graph.
      conn.prepare('UPDATE rentals SET evidence_json = ? WHERE mrr_id = ?')
        .run(JSON.stringify(dispute.buildEvidence(d, g, r, nowSec)), r.mrr_id);
    }
  }

  // --- Reconciliation (recover ambiguous creates; flag strays) ---
  let reconciliation = { adopt: [], unattributable: [] };
  if (fetchOk.rentals && session) {
    // Both the quick-session path (note 'intent') and autopilot's top-up (note 'autopilot
    // intent') anchor a create with an intent row; either can leave an ambiguous-create orphan,
    // so reconcile must match both — otherwise an autopilot orphan is never auto-adopted.
    const intents = conn.prepare(
      `SELECT id, ts, json_extract(proposed_json, '$.rig') AS rig
         FROM decisions WHERE session_id = ? AND note IN ('intent', 'autopilot intent')`,
    ).all(session.id).map((r) => ({ id: r.id, ts: r.ts, rig: r.rig }));
    // Known = EVERY rental we've ever tracked (any session, ended or not), so an ended or
    // prior-session rental that MRR still lists isn't misread as an untracked stray.
    const known = conn.prepare('SELECT mrr_id FROM rentals').all().map((r) => r.mrr_id);
    reconciliation = reconcile({ trackedMrrIds: known, mrrList, intents });
  }

  // --- Balance (blip-safe) ---
  let balance = prev.balance || null;
  try { balance = deposit.balanceToSats(await client.get('/account/balance')); }
  catch { fetchOk.balance = false; }

  // --- Refund reconciliation (piggyback, ~10 min cadence) ---
  let refundAt = prev.refundAt || 0;
  if (nowMs - refundAt >= refunds.REFUND_CADENCE_MS) {
    try {
      const watchDays = config.getKey(conn, 'guardrails', 'refund_watch_days') || 14;
      await refunds.reconcile(conn, client, nowSec, watchDays);
    } catch { /* blip-safe */ }
    refundAt = nowMs;
  }

  // --- Endpoint stratum probe (authoritative endpoint health) ---
  const ep = endpoints.active(conn);
  let endpoint = prev.endpoint || null;
  let gatewayInfo = prev.gateway || null;
  let gatewayAt = prev.gatewayAt || 0;
  let gatewayKey = prev.gatewayKey || null;
  if (ep) {
    try {
      // Resolve to a validated IP every tick and PIN the probe to it — the stored host may be a DNS
      // name that has since rebound to an internal/metadata address; never probe the raw hostname.
      const ip = await endpointUtil.resolvePinnedIp(ep.host);
      if (!ip) {
        if (require('node:net').isIP(ep.host) > 0) {
          // A raw-IP endpoint refused because the literal is blocked (internal/metadata) — keep the
          // existing SSRF-guard behavior: don't probe, hold as a fetch blip.
          fetchOk.endpoint = false;
        } else {
          // A HOSTNAME that doesn't resolve to a usable address (NXDOMAIN, or a name that rebound to a
          // blocked IP) is a REAL endpoint failure, not a blip. Mark it not-ok so a sustained failure
          // escalates to endpoint_down (the ~150s debounce absorbs a transient DNS hiccup). Critical
          // once the endpoint is a DuckDNS name: an IP literal always resolves, so holding this as a
          // blip would silently strand autopilot buying rigs for a dead/reclaimed name.
          endpoint = { host: ep.host, port: ep.port, ok: false, difficulty: null, reachable: false };
        }
      } else {
        const p = await stratum.probe(ip, ep.port, ep.worker_base, { timeoutMs: ctx.probeTimeoutMs || 8000 });
        endpoint = { host: ep.host, port: ep.port, ok: !!p.gotWork, difficulty: p.difficulty, reachable: p.reachable };
        // Re-ask the Gateway what it supports now and then, and at once when the endpoint
        // changes, so the gateway_outdated alert clears by itself after the user upgrades it
        // (the endpoint test is not re-run for that). Only while the endpoint serves work: an
        // endpoint that is down says nothing about its Gateway's version.
        const key = `${ep.id}|${ep.host}|${ep.port}`;
        if (p.gotWork && (gatewayKey !== key || nowMs - gatewayAt >= GATEWAY_CADENCE_MS)) {
          // Its own try: a failure here (a busy database, say) must not mark the endpoint
          // probe above as a blip and so hold back endpoint_down. Its own short timeout, so a
          // gateway that serves work but never answers this cannot hold the tick for long.
          try {
            const caps = await stratum.capabilities(ip, ep.port, { timeoutMs: GATEWAY_TIMEOUT_MS });
            // The endpoint's own algorithm, not the active one: the user may switch while
            // this waits, and the result describes this endpoint's gateway.
            const a = gatewayCaps.assess(caps, { algo: ep.algo || market.activeAlgo(conn), platform: gatewayCaps.platform() });
            gatewayAt = nowMs;
            gatewayKey = key;
            // An endpoint that did not answer keeps what was last known about it (for a day).
            if (a.status !== 'unknown') {
              gatewayInfo = { ...a, algo: ep.algo || null, endpoint_id: ep.id, endpoint: `${ep.host}:${ep.port}`, checked_at: nowSec };
              conn.prepare('UPDATE pool_endpoints SET gateway_json = ? WHERE id = ?').run(JSON.stringify(gatewayInfo), ep.id);
            }
          } catch { /* nothing learned this time; tried again at the next cadence */ }
        }
      }
    } catch { fetchOk.endpoint = false; }
  }
  // What is known about the active endpoint's Gateway: carried across ticks, or read from the
  // endpoint row (set by the endpoint test) after a restart. Only for the endpoint now active.
  if (ep) {
    if (!gatewayInfo || gatewayInfo.endpoint_id !== ep.id) {
      try { gatewayInfo = ep.gateway_json ? { ...JSON.parse(ep.gateway_json), endpoint_id: ep.id } : null; } catch { gatewayInfo = null; }
    }
    // What is known is about the host it was asked of. DuckDNS and endpoint repair move the
    // same row to a new host; until the new one has answered, nothing is known about it.
    if (gatewayInfo && gatewayInfo.endpoint && gatewayInfo.endpoint !== `${ep.host}:${ep.port}`) gatewayInfo = null;
    // Nor is a result from more than a day ago something to keep warning on: a gateway that
    // has stopped answering the check since (after an upgrade, say) is no longer known.
    if (gatewayInfo && gatewayInfo.checked_at && nowSec - gatewayInfo.checked_at > GATEWAY_STALE_SEC) gatewayInfo = null;
  } else {
    gatewayInfo = null;
  }

  // --- HashGG probe (optional) ---
  let hg = prev.hashgg || null;
  if (ctx.hashggHost) {
    try { hg = await hashgg.probe(ctx.hashggHost, ctx.hashggPort || 3000); }
    catch { fetchOk.hashgg = false; }
  }

  // --- Market snapshot (5-min cadence) ---
  let mkt = prev.market || null;
  let marketAt = prev.marketAt || 0;
  if (nowMs - marketAt >= MARKET_CADENCE_MS) {
    try {
      const rigs = await market.fetchAllRigs(client, market.activeAlgo(conn));
      const snap = market.buildMarketSnapshot(rigs, nowSec);
      try {
        const algo = await client.get('/info/algos/' + market.activeAlgo(conn));
        const prices = (algo && algo.stats && algo.stats.prices) || (algo && algo.prices) || {};
        // market_snapshots stores per-TH/day (like `lowest`), so normalize. The unit comes
        // from the response ("ph*day" for sha256ab, "th*day" for blake2b) rather than a fixed
        // divide by 1000, which would store blake2b prices a thousandfold low and quietly
        // poison every price chart and market comparison built on them.
        const perTh = (o) => {
          if (!o || o.amount == null || o.amount === '') return null;
          const n = Number(o.amount);
          if (!Number.isFinite(n)) return null;
          try { return n / units.perThFactor(String(o.unit || '').split('*')[0]); } catch { return null; }
        };
        snap.last10 = perTh(prices.last_10);
        snap.last = perTh(prices.last);
      } catch { /* prices are a nice-to-have */ }
      market.writeSnapshot(conn, snap);
      mkt = snap; marketAt = nowMs;
    } catch { fetchOk.market = false; }
  }

  // --- Retention pruning (daily) ---
  let pruneAt = prev.pruneAt || 0;
  if (nowMs - pruneAt >= 24 * 3600 * 1000) {
    try { prune.prune(conn, nowSec); } catch { /* best effort */ }
    pruneAt = nowMs;
  }

  const snapshot = {
    ts: nowSec,
    fetch_ok: fetchOk,
    session,
    rentals: rentalsOut,
    reconciliation,
    balance,
    endpoint,
    gateway: gatewayInfo,
    hashgg: hg,
    // Whether HashGG is configured at all. Lets the tick metric distinguish "not
    // configured" (n/a) from "configured but unreachable" (a real outage), so uptime
    // stats don't read 0% HashGG for users who don't run it.
    hashgg_configured: !!ctx.hashggHost,
    market: mkt,
  };
  const nextState = { rentals: nextRentals, marketAt, refundAt, pruneAt, market: mkt, balance, endpoint, hashgg: hg, gateway: gatewayInfo, gatewayAt, gatewayKey };
  return { snapshot, nextState };
}

module.exports = { observe, reconcile, mergeRental, MARKET_CADENCE_MS, ADOPT_WINDOW_SEC };
