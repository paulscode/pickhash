'use strict';
/*
 * Fetch the account Payment/Rental-Fee ledger covering a session, so a summary can be reconciled
 * against MRR's OWN billing rather than our arithmetic.
 *
 * PAGINATES the transactions endpoint (start/limit) so a long / high-volume session — which can
 * easily exceed one page since every rent posts a Payment + a Rental Fee row and deposits/refunds
 * add more — isn't silently truncated to a recorded-only fallback. Rows are deduped by transaction
 * id: `start` is a moving offset, so a new row posting between page fetches would otherwise shift
 * the window and double-count a Payment (reconcileSpend sums by amount, it doesn't dedup).
 *
 * Blip-safe: returns [] on any failure (and if pagination can't complete within the page cap),
 * which falls back to the recorded per-rental amounts — always safe for the money (only the
 * discrepancy flag is suppressed).
 */
const LIMIT = 100;         // MRR's documented page size for /account/transactions
const MAX_PAGES = 100;     // hard backstop (~10k rows, far beyond any real session) against an unbounded loop

async function fetchSessionLedger(client, session) {
  if (!client || !session) return [];
  const timeGreaterEq = session.started_at || 0;
  const seen = new Set();
  const all = [];
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const a = await client.get('/account/transactions', { time_greater_eq: timeGreaterEq, limit: LIMIT, start: page * LIMIT });
      const rows = (a && a.transactions) || [];
      for (const t of rows) {
        const id = String(t && t.id);
        if (seen.has(id)) continue;   // a page-boundary shift must never double-count a row
        seen.add(id);
        all.push(t);
      }
      if (rows.length < LIMIT) return all;   // a short page is the last page -> the ledger is complete
    }
    return [];   // never reached the final page within the cap -> can't guarantee completeness
  } catch {
    return [];
  }
}

module.exports = { fetchSessionLedger };
