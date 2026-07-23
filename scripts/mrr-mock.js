'use strict';
/*
 * Record/replay mock of the MiningRigRentals API.
 *
 * Replays the recorded fixtures (scrubbed real responses) wrapped in the API's
 * {success, data} envelope, so the engine can be driven end to end in tests and CI
 * without touching the live API or spending BTC. A `scenario` hook injects the hard
 * cases the safety code must handle: ambiguous mutation (hang), nonce rejection,
 * rig-taken race, underdelivery, etc.
 *
 *   createMockServer({ fixturesDir?, scenario? }) -> http.Server   (for in-process tests)
 *   node scripts/mrr-mock.js                                       (standalone, MOCK_PORT env)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_FIXTURES = path.join(__dirname, '../app/backend/test/fixtures/mrr');

function makeLoader(dir) {
  return (name) => {
    const o = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    delete o._note;   // fixtures carry an explanatory _note that isn't part of the API
    return o;
  };
}

/** Map a request to the fixture `data` it should return, or undefined if unknown. */
function route(method, p, load, query = {}) {
  if (method === 'GET' && p === '/whoami') return load('whoami.json');
  if (method === 'GET' && p === '/info/algos/sha256ab') return load('algo-sha256ab.json');
  if (method === 'GET' && p === '/rig') {
    // Paginate over the fixture records so fetchAllRigs terminates correctly.
    const all = load('rig-search.json');
    const offset = Number(query.offset || 0);
    const count = Number(query.count || 100);
    const records = (all.records || []).slice(offset, offset + count);
    return { ...all, offset, count: records.length, records };
  }
  if (method === 'GET' && /^\/rig\/\d+$/.test(p)) {
    const id = p.split('/')[2];
    return (load('rig-search.json').records || []).find((r) => String(r.id) === id);
  }
  if (method === 'GET' && p === '/account') return load('account.json');
  if (method === 'GET' && p === '/account/balance') return load('balance.json');
  if (method === 'GET' && p === '/account/transactions') return load('transactions.json');
  if (method === 'GET' && p === '/account/pool') return [{ id: '7000001', name: 'pickhash-test' }];
  if (method === 'GET' && p === '/account/profile') return [{ id: '7000002', name: 'pickhash-test' }];
  if (method === 'GET' && /^\/rental\/\d+$/.test(p)) return load('rental-created.json');
  if (method === 'GET' && p === '/rental') return { total: 1, records: [load('rental-created.json')] };
  if (method === 'PUT' && p === '/rental') return load('rental-created.json');
  if (method === 'PUT' && /^\/rental\/\d+\/extend$/.test(p)) return load('extend-getcost.json');
  if (method === 'PUT' && p === '/account/pool/test') return load('pool-test-full.json');
  if (method === 'PUT' && p === '/account/pool') return { id: '7000001' };
  if (method === 'PUT' && p === '/account/profile') return { id: '7000002' };
  if (method === 'PUT' && /^\/account\/profile\/\d+\/\d$/.test(p)) return { id: '7000002', success: true, message: 'Updated' };
  if (method === 'PUT' && /^\/rental\/\d+\/pool\/\d$/.test(p)) return { id: p.split('/')[2], success: true };
  if (method === 'PUT' && /^\/rental\/\d+\/message$/.test(p)) return [{ id: p.split('/')[2], success: true }];
  return undefined;
}

function createMockServer(opts = {}) {
  const load = makeLoader(opts.fixturesDir || DEFAULT_FIXTURES);
  const scenario = opts.scenario || (() => null);

  return http.createServer(async (req, res) => {
    const method = req.method;
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    let body = '';
    for await (const chunk of req) body += chunk;
    let params = {};
    try { params = body ? JSON.parse(body) : {}; } catch { /* leave empty */ }

    // Scenario hook: return {hang} to never respond (ambiguous), {status, json} to
    // force a specific response, or {message} for a {success:false} envelope.
    const override = scenario({ method, path: p, params, query });
    if (override) {
      if (override.hang) return;   // client will abort on timeout -> MrrAmbiguousError for a mutation
      res.writeHead(override.status || 200, { 'content-type': 'application/json' });
      const json = override.json !== undefined ? override.json
        : { success: false, data: { message: override.message || 'error' } };
      return res.end(JSON.stringify(json));
    }

    const data = route(method, p, load, query);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data === undefined
      ? { success: false, data: { message: `no fixture for ${method} ${p}` } }
      : { success: true, data }));
  });
}

module.exports = { createMockServer, route };

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 3999);
  createMockServer().listen(port, () => console.log(`[mrr-mock] listening on :${port}`));
}
