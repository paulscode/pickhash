'use strict';
/*
 * Funding: the MRR BTC deposit address, and a watcher that turns balance changes into
 * deposit_seen / deposit_cleared alerts. The transition logic is pure and unit-tested;
 * pollOnce wires it to the API and the alerts table. (The full alert evaluator with
 * arming/debounce arrives later — for now these are written directly.)
 */
const units = require('./units');
const market = require('./market');
const config = require('./config');

/** Extract the BTC deposit address from a GET /account response. Shape verified against the live API. */
function extractBtcAddress(acct) {
  if (!acct) return null;
  const d = acct.deposit || acct.deposit_addresses || {};
  const btc = d.BTC || d.btc;
  if (typeof btc === 'string') return btc;
  if (btc && typeof btc === 'object') return btc.address || btc.addr || null;
  return acct.btc_deposit_address || null;
}

async function depositAddress(client) {
  return extractBtcAddress(await client.get('/account'));
}

/** Pure: given the previous and next balances (in sats), what deposit events fired. */
function depositTransitions(prev, next) {
  const p = { confirmed_sats: prev?.confirmed_sats ?? 0, unconfirmed_sats: prev?.unconfirmed_sats ?? 0 };
  const events = [];
  if (next.unconfirmed_sats > p.unconfirmed_sats) {
    events.push({ kind: 'deposit_seen', delta_sats: next.unconfirmed_sats - p.unconfirmed_sats, balance: next });
  }
  if (next.confirmed_sats > p.confirmed_sats) {
    events.push({ kind: 'deposit_cleared', delta_sats: next.confirmed_sats - p.confirmed_sats, balance: next });
  }
  return events;
}

function balanceToSats(bal) {
  const btc = (bal && bal.BTC) || {};
  return {
    confirmed_sats: units.btcToSats(btc.confirmed || 0),
    unconfirmed_sats: units.btcToSats(btc.unconfirmed || 0),
  };
}

/** Poll the balance once, emit any deposit alerts, and remember the new balance. */
async function pollOnce(conn, client, now = Math.floor(Date.now() / 1000)) {
  const next = balanceToSats(await client.get('/account/balance'));
  const prev = config.get(conn, 'deposit_watch');
  const events = depositTransitions(prev, next);
  for (const e of events) {
    conn.prepare('INSERT INTO alerts (algo, kind, severity, state, fired_at, context_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(market.activeAlgo(conn), e.kind, 'info', 'fired', now, JSON.stringify(e));
  }
  config.set(conn, 'deposit_watch', next);
  return { balance: next, events };
}

module.exports = { depositAddress, extractBtcAddress, depositTransitions, balanceToSats, pollOnce };
