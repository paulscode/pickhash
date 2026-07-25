'use strict';
/*
 * JSON API router (everything under /api). The HTTP layer in server.js handles
 * static files, health, security headers, and body parsing, then delegates here.
 *
 * Setup gate & in-place handoff: until first-run setup is complete, every /api route
 * except the /api/setup/* endpoints returns 412 {needs_setup:true}, and the SPA shows
 * the wizard. Completion just flips a config flag — the check is evaluated live on
 * each request, so the app "hands off" to full operation on the same server, same
 * port, with no restart and no dropped connections.
 */
const net = require('node:net');
const db = require('./db');
const config = require('./config');
const mrr = require('./mrr');
const stratum = require('./stratum');
const hashgg = require('./hashgg');
const endpoint = require('./endpoint');
const bootstrap = require('./bootstrap');
const deposit = require('./deposit');
const auth = require('./auth');
const quoteService = require('./quote-service');
const session = require('./session');
// Aliased at module scope: the /api/diag handler shadows `session` with a local DB row.
const { OCEAN_FALLBACK, oceanFallbackWorker } = session;
const charts = require('./charts');
const market = require('./market');
const messaging = require('./messaging');
const alerts = require('./alerts');
const dispute = require('./engine/dispute');

// Throttle for the authenticated endpoint-probe route (blunts use as an internal scanner).
// Overridable so tests can disable the spacing between rapid consecutive probes.
const POOL_TEST_MIN_INTERVAL_MS = Number(process.env.POOL_TEST_MIN_INTERVAL_MS ?? 1000);
let lastPoolTestAt = 0;

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Hash Value block from the newest market snapshot + the active session's held rentals. */
function hashValueFor(conn) {
  const latest = conn.prepare('SELECT lowest, last10 FROM market_snapshots ORDER BY ts DESC LIMIT 1').get() || null;
  const sess = conn.prepare("SELECT id FROM sessions WHERE state IN ('active','winding_down') ORDER BY id DESC LIMIT 1").get();
  const rentals = sess ? conn.prepare('SELECT rate_btc_th_day, advertised_th, avg_percent FROM rentals WHERE session_id = ? AND ended = 0').all(sess.id) : [];
  return market.hashValue(latest, rentals);
}

/**
 * Your blended pay-rate (sats/PH·day) for the market chart's "you" reference line. Prefers the active
 * session's LIVE rentals; when none are live (session ended, or between top-ups) it falls back to the
 * most recent session that actually rented — so the line persists after a session ends, whether the
 * last run was Autopilot or a Quick Rent. A spend-free DRY-RUN leaves no priced rentals, so it's
 * naturally skipped. Returns { rate: sats/PH·day|null, live } — live=false means the rate is from a
 * finished session, so the UI can label it "you (last)".
 */
function payRateSatsPhDay(conn) {
  const rateFrom = (rows) => market.hashValue(null, rows).your_pay_sats_ph_day;
  const active = conn.prepare("SELECT id FROM sessions WHERE state IN ('active','winding_down') ORDER BY id DESC LIMIT 1").get();
  if (active) {
    const live = rateFrom(conn.prepare('SELECT rate_btc_th_day, advertised_th, avg_percent FROM rentals WHERE session_id = ? AND ended = 0').all(active.id));
    if (live != null) return { rate: live, live: true };
  }
  const recent = conn.prepare('SELECT session_id FROM rentals WHERE rate_btc_th_day IS NOT NULL AND advertised_th > 0 ORDER BY session_id DESC LIMIT 1').get();
  if (!recent) return { rate: null, live: false };
  return { rate: rateFrom(conn.prepare('SELECT rate_btc_th_day, advertised_th, avg_percent FROM rentals WHERE session_id = ?').all(recent.session_id)), live: false };
}

/** MRR credentials have been stored. */
function isConfigured(conn) {
  return !!conn.prepare('SELECT 1 FROM secrets WHERE name = ?').get('mrr_key');
}

/** The first-run wizard has been completed. */
function isSetupComplete(conn) {
  return config.getKey(conn, 'setup', 'completed') === true;
}

async function handleApi(req, res, url, body, ctx = {}) {
  const conn = db.get();
  const method = req.method;
  const p = url.pathname;

  // --- Public auth endpoints (reachable even when not logged in) ---
  if (p === '/api/auth/state' && method === 'GET') {
    const session = auth.sessionFromReq(req);
    const enabled = auth.passwordEnabled(conn);
    return sendJson(res, 200, { password_enabled: enabled, authed: !enabled || !!session, csrf: session ? session.csrf : null, managed: auth.isManaged(), managed_path: process.env.DASHBOARD_PASSWORD_PATH || '' });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    if (!auth.passwordEnabled(conn)) return sendJson(res, 400, { error: 'no_password_set' });
    const r = auth.login(conn, String(body.password || ''));
    if (!r.ok) return sendJson(res, r.reason === 'locked' ? 429 : 401, { error: r.reason, retry_after: r.retryAfter || 0 });
    res.setHeader('Set-Cookie', auth.cookieHeader(r.id));
    return sendJson(res, 200, { ok: true, csrf: r.csrf });
  }

  // --- Auth gate: once a password is set, everything below needs a valid session and
  //     mutating requests need a matching CSRF token. /api/setup/state stays public so
  //     the SPA can route. (First-time set-password is reachable because the gate is
  //     inactive until a password exists.) ---
  if (auth.passwordEnabled(conn) && p !== '/api/setup/state') {
    const session = auth.sessionFromReq(req);
    if (!session) return sendJson(res, 401, { error: 'unauthorized' });
    if (method !== 'GET' && !auth.csrfOk(session, req)) return sendJson(res, 403, { error: 'csrf' });
  }

  // --- Authenticated auth endpoints ---
  if (p === '/api/auth/logout' && method === 'POST') {
    auth.logout(req);
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/auth/set-password' && method === 'POST') {
    // When the platform manages the password (StartOS Configure screen), an in-app
    // change would be overwritten on the next boot — reject it and point the user there.
    if (auth.isManaged()) return sendJson(res, 400, { error: 'password_managed_externally' });
    const password = String(body.password || '');
    if (password.length < 8) return sendJson(res, 400, { error: 'password_too_short' });
    const wasEnabled = auth.passwordEnabled(conn);
    // Changing an existing password requires the current one (a borrowed session shouldn't be able
    // to lock the owner out). This check goes through the SAME global lockout as login, so it can't
    // be used as an unthrottled brute-force oracle. First-time set has no current password.
    if (wasEnabled) {
      const r = auth.guardedVerify(conn, String(body.current_password || ''));
      if (!r.ok) return sendJson(res, r.reason === 'locked' ? 429 : 403, { error: r.reason === 'locked' ? 'locked' : 'wrong_current_password', retry_after: r.retryAfter || 0 });
    }
    auth.setPassword(conn, password);
    // On first set, log the user straight in.
    if (!wasEnabled) {
      const s = auth.createSession();
      res.setHeader('Set-Cookie', auth.cookieHeader(s.id));
      return sendJson(res, 200, { ok: true, csrf: s.csrf });
    }
    return sendJson(res, 200, { ok: true });
  }

  // --- Always-available setup endpoints ---
  if (p === '/api/setup/state' && method === 'GET') {
    return sendJson(res, 200, { configured: isConfigured(conn), completed: isSetupComplete(conn) });
  }

  // Validate and store MRR credentials. Only persists once whoami confirms they work
  // and carry the rent permission. `withdraw_capable` is true only for a WRITE-grade
  // withdraw permission (the risky one) — a read-only withdraw grant is what we recommend.
  if (p === '/api/setup/mrr-keys' && method === 'POST') {
    // Spend-capable credentials may not be stored until a dashboard password protects them —
    // otherwise a port-reachable attacker could connect (and later spend) an account with no login.
    // This makes the wizard's "set a password first" step a server-enforced invariant.
    if (!auth.passwordEnabled(conn) && !auth.isManaged()) return sendJson(res, 403, { error: 'password_required' });
    const key = String(body.key || '').trim();
    const secret = String(body.secret || '').trim();
    if (!key || !secret) return sendJson(res, 400, { error: 'key_and_secret_required' });
    let who;
    try {
      who = await mrr.clientWith(conn, key, secret).get('/whoami');
    } catch {
      // Bad credentials / signature / unreachable — do NOT persist anything.
      return sendJson(res, 400, { error: 'auth_failed', message: 'Could not authenticate. Check the API key and secret.' });
    }
    const perms = who.permissions || {};
    if (perms.rent !== 'yes') {
      return sendJson(res, 400, { error: 'rent_permission_required', permissions: perms });
    }
    mrr.storeCreds(conn, ctx.dataDir, key, secret);
    const withdrawCapable = perms.withdraw === 'yes';
    config.set(conn, 'mrr', { userid: who.userid, username: who.username, withdraw_capable: withdrawCapable });
    // A key change can change withdraw capability, so drop back to DRY-RUN and clear the LIVE
    // confirmation — going LIVE with the new key must re-clear the live-confirmation gate (a rent-only key
    // swapped for a withdraw-capable one can't inherit an unconfirmed 'live' mode).
    config.set(conn, 'run', { mode: 'dry-run', live_confirmed: false });
    return sendJson(res, 200, { userid: who.userid, username: who.username, permissions: perms, withdraw_capable: withdrawCapable });
  }

  // Auto-detect the user's public stratum endpoint from HashGG (optional).
  if (p === '/api/setup/hashgg-detect' && method === 'GET') {
    return sendJson(res, 200, await hashgg.probe(process.env.HASHGG_HOST || '', process.env.HASHGG_PORT || '3000'));
  }

  // Validate a stratum endpoint. Our own AsicBoost-aware probe is authoritative; MRR's
  // pool test is run too but shown only as advisory (it false-negatives on Datum).
  if (p === '/api/setup/pool-test' && method === 'POST') {
    // Require a password first: this route makes an outbound connection to a user-supplied host, so
    // it must not be reachable unauthenticated (no pre-login internal-probe surface).
    if (!auth.passwordEnabled(conn) && !auth.isManaged()) return sendJson(res, 403, { error: 'password_required' });
    // Accept a pasted "host", "host:port", or "stratum+tcp://host:port" (with or
    // without the separate port field) and normalize to a clean host + port.
    const { host, port } = endpoint.parse(body.host, body.port);
    const user = String(body.user || '').trim();
    const pass = String(body.pass || 'x');
    const isIp = net.isIP(host) > 0;
    if (!host || !port || !user) return sendJson(res, 400, { error: 'host_port_user_required' });
    if (!(/^[a-zA-Z0-9.\-_]+$/.test(host) || isIp) || !(port > 0 && port < 65536)) return sendJson(res, 400, { error: 'invalid_host_or_port' });
    if (!/^[a-zA-Z0-9.\-_]+$/.test(user)) return sendJson(res, 400, { error: 'invalid_worker' });

    // Light throttle so this authenticated endpoint can't be turned into a fast internal scanner.
    const nowMs = Date.now();
    if (nowMs - lastPoolTestAt < POOL_TEST_MIN_INTERVAL_MS) return sendJson(res, 429, { error: 'rate_limited' });
    lastPoolTestAt = nowMs;

    // Resolve to a validated IP and PIN the probe to it, so a pasted host — or a DNS name that
    // rebinds between validation and connect — can't aim the probe at a blocked internal/metadata
    // address. RFC1918/loopback stay allowed (a local HashGG/Datum/miner is the ordinary case).
    const connectIp = await endpoint.resolvePinnedIp(host);
    if (!connectIp) return sendJson(res, 400, { error: 'endpoint_not_allowed', message: 'That address can’t be used as a stratum endpoint.' });

    const probe = await stratum.probe(connectIp, port, user, { pass, timeoutMs: 12000 });

    let mrrAdvisory = null;
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (client) {
      try { mrrAdvisory = await client.put('/account/pool/test', { method: 'full', type: 'sha256ab', host, port, user, pass }); }
      catch (e) { mrrAdvisory = { error: e.name }; }
    }

    // Persist as the active endpoint ONLY when the probe confirmed work — a failed test
    // must not deactivate a previously-working endpoint. worker_base is the FULL entered
    // username (per-rental workers append "-r<rentalid>" to it, so it needs the address).
    if (probe.gotWork) {
      conn.prepare('UPDATE pool_endpoints SET active = 0').run();
      conn.prepare(
        `INSERT INTO pool_endpoints (name, source, host, port, worker_base, stratum_diff, last_test_json, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(`endpoint:${host}:${port}`, 'manual', host, port, user, probe.difficulty,
        JSON.stringify({ probe, mrrAdvisory, isIp, at: Math.floor(Date.now() / 1000) }));
    }

    return sendJson(res, 200, {
      ok: probe.gotWork,
      probe,
      mrr_advisory: mrrAdvisory,
      bare_ip: isIp,
      warning: isIp
        ? 'Bare-IP endpoint: MRR does not refund rentals pointed at IP-based pools — prefer a DNS hostname (a HashGG playit tunnel gives you one).'
        : null,
    });
  }

  // Deposit address + balance (read-only — no state changes on a GET). The deposit
  // watcher that emits deposit_seen/cleared alerts runs in the control loop later.
  if (p === '/api/setup/deposit' && method === 'GET') {
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    try {
      const address = await deposit.depositAddress(client);
      const bal = deposit.balanceToSats(await client.get('/account/balance'));
      return sendJson(res, 200, { address, ...bal });
    } catch {
      return sendJson(res, 502, { error: 'account_fetch_failed' });
    }
  }

  // Ensure the MRR saved pool + sha256ab profile exist for the active endpoint.
  if (p === '/api/setup/bootstrap' && method === 'POST') {
    if (!isConfigured(conn)) return sendJson(res, 400, { error: 'mrr_not_configured' });
    const ep = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1').get();
    if (!ep) return sendJson(res, 400, { error: 'no_endpoint' });
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    try {
      const r = await bootstrap.ensure(conn, client, ep);
      return sendJson(res, 200, { pool_id: r.poolId, profile_id: r.profileId });
    } catch {
      return sendJson(res, 502, { error: 'bootstrap_failed', message: 'Could not set up the MRR pool/profile.' });
    }
  }

  if (p === '/api/setup/complete' && method === 'POST') {
    if (!isConfigured(conn)) return sendJson(res, 400, { error: 'mrr_not_configured' });
    // Require an active endpoint whose pool/profile bootstrap succeeded (mrr_profile_id
    // set), so setup can't complete with no usable pool for the engine to rent against.
    const ep = conn.prepare('SELECT mrr_profile_id FROM pool_endpoints WHERE active = 1').get();
    if (!ep || !ep.mrr_profile_id) return sendJson(res, 400, { error: 'setup_incomplete' });
    config.set(conn, 'setup', { completed: true, completed_at: Math.floor(Date.now() / 1000) });
    return sendJson(res, 200, { completed: true });
  }
  // Other setup endpoints (MRR keys, pool, funding) are added in later steps.
  if (p.startsWith('/api/setup/')) return sendJson(res, 404, { error: 'not_found' });

  // --- Setup gate: the rest of the API is closed until the wizard completes ---
  if (!isSetupComplete(conn)) return sendJson(res, 412, { needs_setup: true });

  // --- App API (grows in later phases) ---
  if (p === '/api/status' && method === 'GET') {
    const mode = config.getKey(conn, 'run', 'mode') || 'dry-run';
    const s = conn.prepare("SELECT * FROM sessions WHERE state IN ('active', 'winding_down') ORDER BY id DESC LIMIT 1").get();
    let sessionOut = null;
    let rentals = [];
    if (s) {
      sessionOut = {
        id: s.id, mode: s.mode, state: s.state, target_th: s.target_th, budget_sats: s.budget_sats,
        duration_hours: s.duration_hours, time_cap_hours: s.time_cap_hours, spent_sats: s.spent_sats, fee_sats: s.fee_sats, started_at: s.started_at,
      };
      // Rig name/region are third-party strings — passed raw for the client to render via x-text.
      rentals = conn.prepare(
        `SELECT mrr_id, rig_id, rig_name, region, advertised_th, length_hours, paid_sats, fee_sats,
                start_ts, end_ts, health, avg_percent FROM rentals WHERE session_id = ? ORDER BY id`,
      ).all(s.id);
    }
    // Latest engine-observed balance (already polled each tick) so the dashboard balance
    // card updates live off /api/status without an extra per-poll MRR call.
    const bal = conn.prepare(
      'SELECT balance_confirmed_sats AS c, balance_unconfirmed_sats AS u FROM tick_metrics WHERE balance_confirmed_sats IS NOT NULL ORDER BY ts DESC LIMIT 1',
    ).get();
    const balance = bal ? { confirmed_sats: bal.c, unconfirmed_sats: bal.u } : null;
    return sendJson(res, 200, { ok: true, mode, session: sessionOut, rentals, balance, hash_value: hashValueFor(conn), alerts: alerts.listActive(conn) });
  }

  // Chart models for the dashboard (built server-side, pure). ?range=6h|24h|7d|all.
  if (p === '/api/metrics' && method === 'GET') {
    const latest = conn.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').get() || null;
    const RANGES = { '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400, '30d': 30 * 86400 };
    const range = url.searchParams.get('range') || 'all';
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceTs = RANGES[range] ? nowSec - RANGES[range] : 0;
    // Scope delivered/spend/stacked to the latest session so a wide range doesn't blend
    // sessions (cumulative spend would sawtooth; stacks would mix prior-session rigs).
    // Market is global, so it stays time-only.
    const sid = latest ? latest.id : -1;
    const ticks = conn.prepare('SELECT ts, delivered_th, target_th, spent_sats FROM tick_metrics WHERE session_id = ? AND ts >= ? ORDER BY ts').all(sid, sinceTs);
    const snaps = conn.prepare('SELECT ts, lowest, last10 FROM market_snapshots WHERE ts >= ? ORDER BY ts').all(sinceTs);
    const samples = conn.prepare(
      `SELECT rs.rental_id, rs.ts, rs.delivered_th, r.rig_name, r.end_ts
         FROM rental_samples rs JOIN rentals r ON r.mrr_id = rs.rental_id
        WHERE r.session_id = ? AND rs.ts >= ? ORDER BY rs.ts`,
    ).all(sid, sinceTs);
    const targetTh = latest ? latest.target_th : null;
    const pr = payRateSatsPhDay(conn);
    return sendJson(res, 200, {
      range,
      delivered: charts.buildDelivered(ticks, { targetTh }),
      delivered_stacked: charts.buildDeliveredStacked(samples, ticks, { targetTh }),
      spend: charts.buildSpend(ticks, { budgetSats: latest ? latest.budget_sats : null }),
      // Overlay the pay-rate on the market chart; the dashboard's hash-value readout comes from /api/status.
      market: charts.buildMarket(snaps, { payRate: pr.rate, payLive: pr.live }),
    });
  }

  // Market page: depth (available TH by price), per-region availability, price history, and a
  // "cheap right now?" read of the current lowest vs the last 30 days of snapshots.
  if (p === '/api/market' && method === 'GET') {
    const nowSec = Math.floor(Date.now() / 1000);
    const latest = conn.prepare('SELECT * FROM market_snapshots ORDER BY ts DESC LIMIT 1').get() || null;
    const history = conn.prepare('SELECT ts, lowest, last10, last FROM market_snapshots WHERE ts >= ? ORDER BY ts').all(nowSec - 30 * 86400);
    let depth = [];
    if (latest && latest.depth_json) { try { depth = JSON.parse(latest.depth_json); } catch { depth = []; } }
    const hv = hashValueFor(conn);
    const pr = payRateSatsPhDay(conn);
    return sendJson(res, 200, {
      summary: latest ? {
        ts: latest.ts, lowest: latest.lowest, last10: latest.last10, last: latest.last,
        available_rigs: latest.available_rigs, available_th: latest.available_th,
        lowest_sats_ph_day: latest.lowest != null ? Math.round(latest.lowest * 1e11) : null,
      } : null,
      depth_chart: charts.buildDepth(depth),
      price_history: charts.buildMarket(history, { payRate: pr.rate, payLive: pr.live }),
      regions: market.depthByRegion(depth),
      cheap_now: market.cheapNow(latest ? latest.lowest : null, history),
      hash_value: hv,
    });
  }

  // Session history: ended sessions with reconciled summaries + per-rig delivery, and
  // dispute info (deadline/links/evidence) for any rental that ended under 95%.
  if (p === '/api/session/history' && method === 'GET') {
    const tryParse = (s) => { try { return s && s !== 'DEMO' ? JSON.parse(s) : null; } catch { return null; } };
    // Per-rig learned score + manual-blacklist status, for the rig-breakdown scorecard.
    const blacklist = new Set((config.getKey(conn, 'strategy', 'blacklist_rig_ids') || []).map(String));
    const scores = {};
    for (const sr of conn.prepare('SELECT rig_id, rentals, mean_percent FROM rig_scores').all()) scores[String(sr.rig_id)] = sr;
    const sessions = conn.prepare("SELECT * FROM sessions WHERE state = 'ended' ORDER BY COALESCE(ended_at, created_at) DESC LIMIT 50").all();
    const out = sessions.map((s) => {
      const summary = tryParse(s.summary_json);
      if (summary && summary.dry_run) return null;   // rehearsals aren't real history
      const rigs = conn.prepare('SELECT * FROM rentals WHERE session_id = ? ORDER BY id').all(s.id).map((r) => {
        const disputable = r.end_ts != null && (dispute.isDisputable(r.avg_percent) || r.avg_percent == null);
        const ev = tryParse(r.evidence_json);
        const sc = scores[String(r.rig_id)];
        return {
          rig_id: r.rig_id, name: r.rig_name, region: r.region, advertised_th: r.advertised_th,
          avg_percent: r.avg_percent, cost_sats: (r.paid_sats || 0) + (r.fee_sats || 0), refund_sats: r.refund_sats || 0,
          score_percent: sc && sc.mean_percent != null ? Math.round(sc.mean_percent * 10) / 10 : null,
          score_rentals: sc ? sc.rentals : 0,
          blacklisted: blacklist.has(String(r.rig_id)),
          disputable,
          deadline_ts: disputable ? dispute.disputeDeadlineTs(r.end_ts) : null,
          links: disputable ? dispute.links(r.mrr_id) : null,
          evidence_text: disputable ? dispute.evidenceText(r, ev) : null,
        };
      });
      return {
        id: s.id, mode: s.mode, started_at: s.started_at, ended_at: s.ended_at, duration_hours: s.duration_hours,
        spent_sats: s.spent_sats, target_th: s.target_th,
        effective_sats_per_th_day: summary ? summary.effective_sats_per_th_day : null,
        delivered_th_hours: summary ? summary.delivered_th_hours : null,
        refund_sats: summary ? summary.refund_sats : 0,
        rigs,
      };
    }).filter(Boolean);
    return sendJson(res, 200, { sessions: out });
  }

  // Active alerts + ack.
  if (p === '/api/alerts' && method === 'GET') {
    return sendJson(res, 200, { alerts: alerts.listActive(conn) });
  }
  if (p === '/api/alerts/ack' && method === 'POST') {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'id_required' });
    return sendJson(res, 200, { ok: alerts.ack(conn, id) });
  }

  // Deposit address + live balance for the dashboard (read-only; no state changes).
  if (p === '/api/deposit' && method === 'GET') {
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    try {
      const address = await deposit.depositAddress(client);
      const bal = deposit.balanceToSats(await client.get('/account/balance'));
      return sendJson(res, 200, { address, ...bal });
    } catch {
      return sendJson(res, 502, { error: 'account_fetch_failed' });
    }
  }

  // Price a quote from three linked inputs + a lock (the field to solve for), over
  // fresh market data. Returns a fee-inclusive quote with a short-lived id.
  if (p === '/api/quote' && method === 'POST') {
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    const compute = String(body.compute || 'duration');
    if (!['duration', 'hashrate', 'spend'].includes(compute)) return sendJson(res, 400, { error: 'bad_compute' });
    try {
      const q = await quoteService.buildQuote(conn, client, {
        compute,
        spendSats: body.spend_sats != null ? Number(body.spend_sats) : null,
        hashrateTh: body.hashrate_th != null ? Number(body.hashrate_th) : null,
        durationHours: body.duration_hours != null ? Number(body.duration_hours) : null,
      });
      return sendJson(res, 200, q);
    } catch (e) {
      if (e.message === 'no_endpoint' || e.message === 'missing_inputs' || e.message === 'bad_compute') {
        return sendJson(res, 400, { error: e.message });
      }
      return sendJson(res, 502, { error: 'quote_failed' });
    }
  }

  // Execute (or rehearse) a confirmed quote as a session. LIVE only when the app is in
  // LIVE run mode; the body may force a DRY-RUN rehearsal but can never force a spend.
  if (p === '/api/session' && method === 'POST') {
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    const quoteId = String(body.quote_id || '');
    if (!quoteId) return sendJson(res, 400, { error: 'quote_id_required' });
    const runMode = config.getKey(conn, 'run', 'mode') || 'dry-run';
    const dryRun = runMode !== 'live' || body.dry_run === true;
    try {
      const r = await session.startSession(conn, client, quoteId, { dryRun });
      return sendJson(res, 200, r);
    } catch (e) {
      if (e instanceof session.SessionError) {
        const status = (e.code === 'session_in_progress' || e.code === 'session_active' || e.code === 'no_rigs_available' || e.code === 'endpoint_down') ? 409
          : e.code === 'quote_expired' ? 410
            : e.code === 'insufficient_balance' ? 402
              : e.code === 'balance_unavailable' ? 502 : 400;
        return sendJson(res, status, { error: e.code });
      }
      return sendJson(res, 502, { error: 'session_failed' });
    }
  }

  // Switch the run mode. DRY-RUN is always allowed. Going LIVE requires MRR configured, and —
  // for a withdraw-capable key — a one-time typed "LIVE" confirmation before the
  // engine is ever allowed to spend real Bitcoin autonomously.
  if (p === '/api/run-mode' && method === 'POST') {
    const mode = body.mode === 'live' ? 'live' : 'dry-run';
    if (mode === 'dry-run') {
      config.set(conn, 'run', { mode: 'dry-run' });
      return sendJson(res, 200, { mode: 'dry-run' });
    }
    if (!isConfigured(conn)) return sendJson(res, 400, { error: 'mrr_not_configured' });
    // A dashboard password is REQUIRED before the engine may spend real Bitcoin: without one,
    // anyone who can reach the port could enable LIVE mode. DRY-RUN stays open (no spend), so
    // the password remains optional for rehearsal-only use.
    if (!auth.passwordEnabled(conn) && !auth.isManaged()) {
      return sendJson(res, 403, { error: 'password_required' });
    }
    // Re-verify the key's withdraw capability live, so a permission that was elevated on the
    // marketplace side (without re-entering the key here) can't slip past the extra confirmation
    // the higher-blast-radius key is supposed to require. If MRR is unreachable, fall back to the
    // cached value rather than blocking the mode switch on a remote outage.
    let withdrawCapable = config.getKey(conn, 'mrr', 'withdraw_capable') === true;
    try {
      const who = await mrr.clientFromStore(conn, ctx.dataDir).get('/whoami');
      const freshWithdraw = ((who && who.permissions) || {}).withdraw === 'yes';
      if (freshWithdraw !== withdrawCapable) {
        withdrawCapable = freshWithdraw;
        config.set(conn, 'mrr', { withdraw_capable: freshWithdraw });
      }
    } catch { /* MRR unreachable — keep the cached capability */ }
    const alreadyConfirmed = config.getKey(conn, 'run', 'live_confirmed') === true;
    const patch = { mode: 'live' };
    if (withdrawCapable && !alreadyConfirmed) {
      if (String(body.confirm || '').trim().toLowerCase() !== 'live') {
        return sendJson(res, 400, { error: 'confirmation_required', withdraw_capable: true });
      }
      patch.live_confirmed = true;
    }
    config.set(conn, 'run', patch);
    return sendJson(res, 200, { mode: 'live' });
  }

  // Settings: read/write the user-tunable knobs. Only config.SETTINGS namespaces are exposed, so
  // no credential ever appears here; the schema drives the UI and enforces types/bounds server-side.
  if (p === '/api/config' && method === 'GET') {
    const values = {};
    for (const ns of Object.keys(config.SETTINGS)) {
      values[ns] = {};
      for (const key of Object.keys(config.SETTINGS[ns])) values[ns][key] = config.getKey(conn, ns, key);
    }
    return sendJson(res, 200, { schema: config.SETTINGS, values });
  }
  if (p === '/api/config' && method === 'POST') {
    const ns = String(body.ns || '');
    if (!config.SETTINGS[ns]) return sendJson(res, 400, { error: 'bad_namespace' });
    const v = config.validatePatch(ns, body.patch || {});
    if (!v.ok) return sendJson(res, 400, { error: 'invalid_setting', field: v.field, reason: v.reason });
    config.set(conn, ns, v.patch);
    const values = {};
    for (const key of Object.keys(config.SETTINGS[ns])) values[key] = config.getKey(conn, ns, key);
    return sendJson(res, 200, { ns, values });
  }

  // Diagnostics: engine liveness + MRR identity (never secrets) + active alerts, for troubleshooting.
  if (p === '/api/diag' && method === 'GET') {
    const mrrCfg = config.get(conn, 'mrr');
    const nowSec = Math.floor(Date.now() / 1000);
    const lastTick = conn.prepare('SELECT MAX(ts) AS t FROM tick_metrics').get().t || null;
    const ticksHour = conn.prepare('SELECT COUNT(*) AS n FROM tick_metrics WHERE ts >= ?').get(nowSec - 3600).n;
    const session = conn.prepare("SELECT id, mode, state, started_at FROM sessions WHERE state IN ('active','winding_down') ORDER BY id DESC LIMIT 1").get() || null;
    const ep = conn.prepare('SELECT host, port, worker_base, source FROM pool_endpoints WHERE active = 1').get() || null;
    return sendJson(res, 200, {
      mrr: { configured: isConfigured(conn), userid: mrrCfg.userid || null, username: mrrCfg.username || null, withdraw_capable: mrrCfg.withdraw_capable === true },
      run_mode: config.getKey(conn, 'run', 'mode') || 'dry-run',
      engine: { last_tick_ts: lastTick, last_tick_age_sec: lastTick != null ? nowSec - lastTick : null, ticks_last_hour: ticksHour },
      session,
      endpoint: ep ? { host: ep.host, port: ep.port, worker: ep.worker_base, source: ep.source } : null,
      fallback: {
        enabled: !!config.get(conn, 'strategy').fallback_pool_enabled,
        pool: 'Ocean',
        host: OCEAN_FALLBACK.host, port: OCEAN_FALLBACK.port,
        worker: ep ? oceanFallbackWorker(ep.worker_base) : null,
      },
      hashgg_host_set: !!process.env.HASHGG_HOST,
      alerts: alerts.listActive(conn),
    });
  }

  // Owner messaging — read the thread for one of OUR rentals. The owner-authored strings are
  // returned RAW; the frontend renders them with x-text only, never x-html.
  if (p === '/api/rental/messages' && method === 'GET') {
    const mrrId = Number(url.searchParams.get('mrr_id'));
    if (!Number.isFinite(mrrId)) return sendJson(res, 400, { error: 'bad_rental_id' });
    if (!conn.prepare('SELECT 1 FROM rentals WHERE mrr_id = ?').get(mrrId)) return sendJson(res, 404, { error: 'unknown_rental' });
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    try {
      const thread = messaging.normalizeThread(await client.get(`/rental/${mrrId}/message`));
      return sendJson(res, 200, { mrr_id: mrrId, messages: thread });
    } catch { return sendJson(res, 502, { error: 'mrr_unavailable' }); }
  }
  // Owner messaging — send a message to the rig owner (a user action, not autonomous spend).
  if (p === '/api/rental/messages' && method === 'POST') {
    const mrrId = Number(body.mrr_id);
    const message = String(body.message || '').trim();
    if (!Number.isFinite(mrrId)) return sendJson(res, 400, { error: 'bad_rental_id' });
    if (!message) return sendJson(res, 400, { error: 'empty_message' });
    if (message.length > 2000) return sendJson(res, 400, { error: 'message_too_long' });
    if (!conn.prepare('SELECT 1 FROM rentals WHERE mrr_id = ?').get(mrrId)) return sendJson(res, 404, { error: 'unknown_rental' });
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    try { await client.put(`/rental/${mrrId}/message`, { message }); return sendJson(res, 200, { ok: true }); }
    catch { return sendJson(res, 502, { error: 'send_failed' }); }
  }

  // Manual per-rig blacklist toggle (rig-breakdown scorecard). A blacklisted rig is filtered out
  // of the candidate set for every quote and every autopilot top-up (strategy.blacklist_rig_ids).
  if (p === '/api/rig/blacklist' && method === 'POST') {
    const rigId = Number(body.rig_id);
    if (!Number.isFinite(rigId)) return sendJson(res, 400, { error: 'bad_rig_id' });
    const set = new Set((config.getKey(conn, 'strategy', 'blacklist_rig_ids') || []).map(Number).filter(Number.isFinite));
    if (body.blacklisted) set.add(rigId); else set.delete(rigId);
    const next = [...set];
    config.set(conn, 'strategy', { blacklist_rig_ids: next });
    return sendJson(res, 200, { rig_id: rigId, blacklisted: set.has(rigId), blacklist_rig_ids: next });
  }

  // Stop the current session (end it, or wind it down if paid rentals are still running).
  if (p === '/api/session/stop' && method === 'POST') {
    // Pass a client so an immediate close reconciles against MRR's ledger (the tick loop won't
    // revisit a session it set to 'ended'). Null-safe: falls back to recorded amounts before setup.
    const r = await session.stopSession(conn, mrr.clientFromStore(conn, ctx.dataDir));
    if (!r.stopped) return sendJson(res, 409, { error: r.reason || 'no_active_session' });
    return sendJson(res, 200, r);
  }

  // Feasibility estimate for an autopilot target/budget (no session created, no mutation).
  if (p === '/api/autopilot/estimate' && method === 'GET') {
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    const targetTh = Number(url.searchParams.get('target_th'));
    const budgetSats = Number(url.searchParams.get('budget_sats'));
    if (!(targetTh > 0) || !(budgetSats > 0)) return sendJson(res, 400, { error: 'bad_params' });
    const endpoint = conn.prepare('SELECT * FROM pool_endpoints WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!endpoint || !endpoint.mrr_profile_id) return sendJson(res, 400, { error: 'no_endpoint' });
    try {
      const estimate = await session.estimateAutopilot(conn, client, { targetTh, budgetSats, endpoint });
      return sendJson(res, 200, { estimate });
    } catch {
      return sendJson(res, 502, { error: 'estimate_failed' });
    }
  }

  // Open an autopilot session (target + time cap + budget). Creates no rentals directly —
  // the control loop fills and maintains the target, run-mode + ceiling + pacing gated.
  if (p === '/api/autopilot/start' && method === 'POST') {
    const client = mrr.clientFromStore(conn, ctx.dataDir);
    if (!client) return sendJson(res, 400, { error: 'mrr_not_configured' });
    try {
      const r = await session.startAutopilotSession(conn, client, {
        targetTh: body.target_th, timeCapHours: body.time_cap_hours, budgetSats: body.budget_sats,
      });
      return sendJson(res, 200, r);
    } catch (e) {
      if (e instanceof session.SessionError) {
        const status = (e.code === 'session_in_progress' || e.code === 'session_active' || e.code === 'no_rigs_available') ? 409
          : e.code === 'exceeds_guardrail' ? 422 : 400;
        return sendJson(res, status, { error: e.code });
      }
      return sendJson(res, 502, { error: 'autopilot_failed' });
    }
  }

  return sendJson(res, 404, { error: 'not_found' });
}

module.exports = { handleApi, isConfigured, isSetupComplete, sendJson, payRateSatsPhDay };
