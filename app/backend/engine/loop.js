'use strict';
/*
 * The control loop.
 *
 *   observe -> decide -> gate -> execute -> persist, every 60s, immediate first tick,
 *   NO overlapping ticks (a slow tick is skipped, never queued).
 *
 * A quick session is monitoring-only: it winds down as rentals expire, so decide/
 * gate/execute do no mutations for it (autopilot sessions do the top-up). Each tick still
 * observes, evaluates alerts, and persists a tick_metrics row — even when observe
 * throws, so the diagnostics/charts always have a row with the right *_ok flags.
 *
 * observeFn is injectable so the loop's timing/overlap/error handling is testable without
 * the whole MRR world.
 */
const observeModule = require('./observe');
const market = require('../market');

const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * Per-tick aggregate row from a snapshot (pure). A null snapshot => an all-not-ok row,
 * with hashgg_ok left null (unknown) since we can't tell if HashGG is even configured.
 */
function buildTickMetrics(snapshot, now) {
  const ts = Math.floor(now / 1000);
  if (!snapshot) {
    return { ts, session_id: null, delivered_th: 0, target_th: 0, active_rentals: 0, spent_sats: 0,
      balance_confirmed_sats: null, balance_unconfirmed_sats: null, market_lowest: null, market_last10: null,
      endpoint_ok: 0, mrr_ok: 0, hashgg_ok: null };
  }
  const s = snapshot;
  const delivered = s.rentals.reduce((a, r) => a + (r.delivered_th || 0), 0);
  const active = s.rentals.filter((r) => !r.ended).length;
  return {
    ts,
    session_id: s.session ? s.session.id : null,
    delivered_th: delivered,
    target_th: s.session ? s.session.target_th : 0,
    active_rentals: active,
    spent_sats: s.session ? s.session.spent_sats : 0,
    balance_confirmed_sats: s.balance ? s.balance.confirmed_sats : null,
    balance_unconfirmed_sats: s.balance ? s.balance.unconfirmed_sats : null,
    market_lowest: s.market ? s.market.lowest : null,
    market_last10: s.market ? s.market.last10 : null,
    endpoint_ok: s.endpoint && s.endpoint.ok ? 1 : 0,
    mrr_ok: s.fetch_ok && s.fetch_ok.rentals ? 1 : 0,
    // null when HashGG isn't configured (n/a), else 1 reachable / 0 unreachable — so
    // uptime stats never count a HashGG "outage" for users who don't run it.
    hashgg_ok: s.hashgg_configured ? (s.hashgg && s.hashgg.reachable ? 1 : 0) : null,
  };
}

function persistTick(conn, snapshot, now) {
  const m = buildTickMetrics(snapshot, now);
  conn.prepare(`INSERT OR REPLACE INTO tick_metrics
    (algo, ts, session_id, delivered_th, target_th, active_rentals, spent_sats, balance_confirmed_sats,
     balance_unconfirmed_sats, market_lowest, market_last10, endpoint_ok, mrr_ok, hashgg_ok)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    market.activeAlgo(conn), m.ts, m.session_id, m.delivered_th, m.target_th, m.active_rentals, m.spent_sats,
    m.balance_confirmed_sats, m.balance_unconfirmed_sats, m.market_lowest, m.market_last10,
    m.endpoint_ok, m.mrr_ok, m.hashgg_ok);
  return m;
}

function createLoop(opts = {}) {
  const { conn, client } = opts;
  const observeFn = opts.observeFn || observeModule.observe;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const nowFn = opts.now || (() => Date.now());
  const onTick = opts.onTick;   // optional hook (alerts wire in here)
  const log = opts.log || (() => {});

  let running = false;
  let timer = null;
  // Seed from the DB on boot (health rehydration) so a restart doesn't reset every rental
  // to 'pending' and spuriously resolve active health alerts.
  let prevState = opts.initialState || { rentals: {}, marketAt: 0, market: null };

  async function tick() {
    if (running) { log({ event: 'tick_skipped' }); return { skipped: true }; }   // overlap guard
    running = true;
    try {
      const now = nowFn();
      let snapshot = null;
      let error = null;
      let idle = false;
      try {
        const r = await observeFn(conn, client, { ...opts.observeCtx, prevState, now });
        snapshot = r.snapshot;
        prevState = r.nextState || prevState;
        idle = !!r.idle;   // unconfigured/no-op tick -> don't write a junk metrics row
      } catch (e) {
        error = e;
        log({ event: 'observe_error', message: String(e && e.message) });
      }
      if (idle) return { skipped: false, idle: true };
      // decide/gate/execute run under autopilot. Quick sessions do no top-up.
      if (onTick) { try { await onTick(snapshot, error); } catch (e) { log({ event: 'ontick_error', message: String(e && e.message) }); } }
      let metrics = null;
      try { metrics = persistTick(conn, snapshot, now); } catch (e) { log({ event: 'persist_error', message: String(e && e.message) }); }
      return { skipped: false, snapshot, error, metrics };
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() { tick(); timer = setInterval(tick, intervalMs); return this; },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    get running() { return running; },
  };
}

module.exports = { createLoop, buildTickMetrics, persistTick, DEFAULT_INTERVAL_MS };
