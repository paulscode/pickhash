'use strict';
/*
 * Switching algorithms is its own action, with its own checks.
 *
 * It is not a knob among knobs: it changes which market is bought from, which
 * guardrails apply, which endpoint is live and which marketplace account objects are
 * used. The dangerous moment is doing it while money is in flight, because the
 * running loop would go on maintaining a target it can no longer buy for, and the
 * rentals already paid for on the other market would go unmanaged.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const config = require('../config');
const market = require('../market');
const algos = require('../algos');
const { handleApi } = require('../api');

// Async body, so the close has to wait for it. Returning the promise from a sync
// try/finally closes the database out from under the test.
async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-sw-'));
  db.open(dir);
  try { return await fn(db.get(), dir); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Drive one API route and capture what it sent. */
async function call(dataDir, method, p, body) {
  const out = { status: 0, json: null };
  const res = {
    writeHead(status) { out.status = status; },
    setHeader() {},
    end(payload) { try { out.json = JSON.parse(payload); } catch { out.json = payload; } },
  };
  await handleApi({ method, headers: {}, url: p }, res, new URL(p, 'http://x'), body || {}, { dataDir });
  return out;
}

test('the switch changes the active algorithm and reports the new one', async () => {
  await withDb(async (conn, dir) => {
    assert.equal(market.activeAlgo(conn), 'sha256ab');
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 200);
    assert.equal(r.json.algorithm.slug, 'blake2b');
    assert.equal(r.json.algorithm.price_unit, 'th');
    assert.equal(market.activeAlgo(conn), 'blake2b');
  });
});

test('an unknown algorithm is refused', async () => {
  await withDb(async (conn, dir) => {
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'scrypt' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'unknown_algorithm');
    assert.equal(market.activeAlgo(conn), 'sha256ab', 'unchanged');
  });
});

test('the switch is refused while a session is live, and changes nothing', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare(
      `INSERT INTO sessions (algo, mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('sha256ab', 'autopilot', 'active', 100, 500000, 24, 0, 0, 1, 1)`,
    ).run();
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'session_active');
    assert.equal(market.activeAlgo(conn), 'sha256ab', 'the setting did not move');
  });
});

test('a winding-down session blocks it too', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare(
      `INSERT INTO sessions (algo, mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('sha256ab', 'autopilot', 'winding_down', 100, 500000, 24, 0, 0, 1, 1)`,
    ).run();
    // Rentals bought on the other market are still running and still being managed.
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 409);
  });
});

test('an ended session does not block it', async () => {
  await withDb(async (conn, dir) => {
    conn.prepare(
      `INSERT INTO sessions (algo, mode, state, target_th, budget_sats, time_cap_hours, spent_sats, fee_sats, created_at, started_at)
         VALUES ('sha256ab', 'autopilot', 'ended', 100, 500000, 24, 0, 0, 1, 1)`,
    ).run();
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 200);
  });
});

test('the switch is recorded, stamped with the algorithm it moved to', async () => {
  await withDb(async (conn, dir) => {
    await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    const d = conn.prepare("SELECT algo, note FROM decisions WHERE note LIKE 'algorithm switched%'").get();
    assert.ok(d, 'the switch left a record');
    assert.equal(d.algo, 'blake2b');
    assert.match(d.note, /from sha256ab to blake2b/);
  });
});

test('switching to the algorithm already active is a no-op, not an error', async () => {
  await withDb(async (conn, dir) => {
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'sha256ab' });
    assert.equal(r.status, 200);
    assert.equal(conn.prepare("SELECT COUNT(*) n FROM decisions WHERE note LIKE 'algorithm switched%'").get().n, 0);
  });
});

test('the switch works before setup completes, so the endpoint is saved under the right one', async () => {
  await withDb(async (conn, dir) => {
    // The saved endpoint belongs to an algorithm. Choosing after saving one is exactly
    // the mismatch this work exists to prevent, so the route sits above the setup gate.
    assert.equal(config.getKey(conn, 'setup', 'completed'), undefined, 'setup is not complete');
    const r = await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    assert.equal(r.status, 200);
    assert.equal(market.activeAlgo(conn), 'blake2b');
    // And the rest of the API is still closed, so lifting it did not open a hole.
    assert.equal((await call(dir, 'GET', '/api/status')).status, 412);
  });
});

test('status and config both describe the algorithm the same way', async () => {
  await withDb(async (conn, dir) => {
    config.set(conn, 'setup', { completed: true });
    await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
    const status = await call(dir, 'GET', '/api/status');
    const cfg = await call(dir, 'GET', '/api/config');
    // The header reads one and the settings card reads the other. If they could
    // disagree, the badge whose whole job is to be trusted at a glance would be the
    // thing that was wrong.
    assert.deepEqual(status.json.algorithm, cfg.json.algorithm);
    assert.equal(status.json.algorithm.slug, 'blake2b');
    assert.deepEqual(cfg.json.algorithm.choices.map((c) => c.slug), algos.SLUGS);
  });
});

test('nothing the setup wizard can click calls an endpoint the setup gate closes', () => {
  /*
   * The wizard runs before setup completes, when every route but a named few answers
   * 412. A handler on a wizard control that calls a gated route fails silently: the
   * control moves, the setting does not, and the only sign is a line in the browser
   * console. Switching algorithm did exactly that, and so did both fallback toggles.
   *
   * Derived rather than listed, because the wizard gains controls over time and the
   * gate is not obvious from the frontend.
   */
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'frontend', 'app.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'backend', 'api.js'), 'utf8');

  // What the server actually leaves open, read from the gate itself.
  const gate = api.indexOf("if (!isSetupComplete(conn)) return sendJson(res, 412");
  assert.notEqual(gate, -1, 'the setup gate moved; update this test');
  const open = new Set([...api.slice(0, gate).matchAll(/p === '(\/api\/[a-z0-9/_-]+)'/g)].map((m) => m[1]));

  // The wizard is the x-show="sN" step blocks.
  const steps = [...html.matchAll(/x-show="s\d"/g)].map((m) => m.index);
  assert.ok(steps.length, 'no wizard steps found; update this test');
  let region = html.slice(steps[0]);
  for (const marker of ['id="app"', 'x-show="showApp"', '============ SETTINGS']) {
    const k = region.indexOf(marker);
    if (k > 0) { region = region.slice(0, k); break; }
  }
  const handlers = [...new Set([...region.matchAll(/(?:@click|@change|@submit)(?:\.\w+)*="(\w+)\(/g)].map((m) => m[1]))];
  assert.ok(handlers.length > 3, 'wizard handlers not found; update this test');

  // Resolve what a handler reaches, not just what it calls directly. switchAlgorithm
  // hit /api/config through loadSettings(), one level down, which is exactly how the
  // bug survived review.
  const bodyOf = (name) => {
    const m = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`).exec(js);
    if (!m) return null;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < js.length; i++) {
      if (js[i] === '{') depth++;
      else if (js[i] === '}' && --depth === 0) return js.slice(m.index + m[0].length, i);
    }
    return null;
  };

  const problems = [];
  for (const entry of handlers) {
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name) || seen.size > 40) continue;
      seen.add(name);
      const body = bodyOf(name);
      if (body === null) continue;
      // A body that returns early unless appReady never runs in the wizard, so neither
      // its own calls nor anything it would have called counts. The guard may sit on the
      // handler or on a helper it shares, and both are fine.
      if (/!this\.appReady/.test(body)) continue;
      const completesAt = body.indexOf('/api/setup/complete');
      for (const call of body.matchAll(/(?:send|getJson)\(\s*(?:'\w+',\s*)?'(\/api\/[a-z0-9/_-]+)/g)) {
        if (open.has(call[1])) continue;
        if (completesAt !== -1 && call.index > completesAt) continue;
        problems.push(`${entry}() reaches ${call[1]} via ${name}(), which the setup gate closes`);
      }
      for (const inner of body.matchAll(/this\.(\w+)\(/g)) queue.push(inner[1]);
    }
  }

  assert.deepEqual([...new Set(problems)], [],
    `a wizard control calls a route that returns 412 before setup completes:\n${[...new Set(problems)].join('\n')}`);
});

test('the setup wizard can pick which HashGG to read the endpoint from', async () => {
  /*
   * The choice is a per-algorithm setting, stored in `strategy`, which the wizard
   * cannot write: /api/config is behind the setup gate. Telling a user to change it
   * in Settings, which is what the failed-detection message used to say, is advice
   * they cannot take until setup is finished.
   *
   * So detect takes the source as a parameter, and the algorithm block carries the
   * default and the options so the wizard can offer them before it can store one.
   */
  await withDb(async (conn, dir) => {
    process.env.HASHGG_HOST = 'flagship.invalid';
    process.env.HASHGG_COMPANION_HOST = 'companion.invalid';
    try {
      const block = (await call(dir, 'GET', '/api/algorithm')).json.algorithm;
      assert.equal(block.hashgg_source, 'flagship', "sha256ab's default");
      assert.deepEqual(block.hashgg_sources.map((s) => s.source), algos.SLUGS.length ? ['flagship', 'companion'] : []);
      assert.deepEqual(block.hashgg_sources.map((s) => s.label), ['HashGG', 'HashGG Companion'],
        'the wizard needs names, not slugs, to put in a dropdown');

      // An explicit choice wins over the algorithm's default, which is the whole point:
      // the Companion is the blake2b default, and a user whose ordinary HashGG serves
      // the gateway has to be able to say so during setup.
      assert.equal((await call(dir, 'GET', '/api/setup/hashgg-detect?source=companion')).json.source, 'companion');
      assert.equal((await call(dir, 'GET', '/api/setup/hashgg-detect?source=flagship')).json.source, 'flagship');

      // Nonsense falls back to the algorithm's answer rather than probing nothing.
      assert.equal((await call(dir, 'GET', '/api/setup/hashgg-detect?source=nope')).json.source, 'flagship');
      assert.equal((await call(dir, 'GET', '/api/setup/hashgg-detect')).json.source, 'flagship');

      // And the default follows a switch, while an explicit choice still overrides it.
      await call(dir, 'POST', '/api/algorithm', { algo: 'blake2b' });
      assert.equal((await call(dir, 'GET', '/api/algorithm')).json.algorithm.hashgg_source, 'companion');
      assert.equal((await call(dir, 'GET', '/api/setup/hashgg-detect?source=flagship')).json.source, 'flagship');
    } finally {
      delete process.env.HASHGG_HOST;
      delete process.env.HASHGG_COMPANION_HOST;
    }
  });
});

test('a select whose options come from x-for has its model set after they render', () => {
  /*
   * x-model applies its value when the select is created, which is before x-for has
   * produced any <option>. With nothing to match, the browser shows the first option
   * while the model still holds the real value. The control then disagrees with what
   * the app will actually do, silently: the HashGG select read "HashGG" while detect
   * used the Companion, and the algorithm select had the same fault.
   *
   * The fix is to assign inside $nextTick. This checks every such select rather than
   * the two that were found, because nothing about the symptom points at the cause.
   */
  const root = path.join(__dirname, '..', '..', 'frontend');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  const models = new Set();
  const ownHandlers = new Set();
  for (const m of html.matchAll(/<select\b[^>]*>/g)) {
    const model = /x-model="(\w+)"/.exec(m[0]);
    if (!model) continue;
    const body = html.slice(m.index + m[0].length, html.indexOf('</select>', m.index));
    if (!body.includes('x-for')) continue;
    models.add(model[1]);
    // The select's own change handler runs after the user has used it, so the options
    // exist by then and it may assign freely.
    const handler = /@change="(\w+)\(/.exec(m[0]);
    if (handler) ownHandlers.add(handler[1]);
  }
  assert.ok(models.size, 'no x-for-populated selects found; update this test');

  // The method an offset falls inside, by the last method opener above it.
  const methodAt = (offset) => {
    let name = null;
    const KEYWORD = /^(if|for|while|switch|catch|do|try|return|function|else)$/;
    for (const m of js.matchAll(/^\s{4,6}(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm)) {
      if (m.index > offset) break;
      if (KEYWORD.test(m[1])) continue;
      name = m[1];
    }
    return name;
  };

  const problems = [];
  for (const model of models) {
    // Every assignment to the model from application code, ignoring the declaration.
    for (const a of js.matchAll(new RegExp(`this\\.${model}\\s*=`, 'g'))) {
      const line = js.slice(0, a.index).split('\n').length;
      // Look back a little: an assignment inside a $nextTick callback is the safe form.
      const before = js.slice(Math.max(0, a.index - 200), a.index);
      const inNextTick = /\$nextTick\(\s*\(\)\s*=>\s*\{[^}]*$/.test(before);
      const fromUserEdit = ownHandlers.has(methodAt(a.index));
      if (!inNextTick && !fromUserEdit) {
        problems.push(`app.js:${line} sets ${model} outside $nextTick; the options may not exist yet`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
