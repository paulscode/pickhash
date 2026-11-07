'use strict';
/*
 * Graceful stop: let money-moving work finish being recorded before the database closes.
 *
 * Creating a rental or extending one is a call to MRR followed by the rows that record it.
 * The call takes seconds; the rows take microseconds. If the process closes its database in
 * between, MRR has billed for something Pickhash never wrote down. A created rental is
 * recovered later from its intent row, but an extension is not: its cost never reaches the
 * session's spend, so the budget silently loses track of it. Updates and service restarts
 * send SIGTERM in the middle of whatever the engine is doing, so this window is hit by
 * ordinary maintenance, not only by crashes.
 *
 * So shutdown is two steps: stop starting new work (`requested`), then wait for work already
 * running (`hold`) to finish, up to a bound, before closing. Work that checks `requested`
 * between rentals stops at the next boundary rather than running to completion.
 */
let stopping = false;
let active = 0;
let waiters = [];

/** True once shutdown has begun: start nothing new. */
function requested() { return stopping; }

/** Run `fn` as work shutdown waits for. */
async function hold(fn) {
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    if (active === 0) { const w = waiters; waiters = []; for (const f of w) f(); }
  }
}

/** Begin shutdown and wait for held work. Resolves true when it all finished, false on timeout. */
function drain(timeoutMs) {
  stopping = true;
  if (active === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    waiters.push(() => { clearTimeout(t); resolve(true); });
  });
}

function _reset() { stopping = false; active = 0; waiters = []; }

module.exports = { requested, hold, drain, _reset };
