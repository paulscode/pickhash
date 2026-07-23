'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const prune = require('../engine/prune');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-prune-'));
before(() => { db.open(DATA); });
after(() => { db.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('prune drops raw rows older than the window but keeps recent + money/audit tables', () => {
  const c = db.get();
  const now = 1_900_000_000;
  const old = now - 100 * 86400;   // 100 days -> pruned (window 90)
  const recent = now - 10 * 86400; // kept
  c.prepare('INSERT OR REPLACE INTO tick_metrics (ts, session_id) VALUES (?, 1)').run(old);
  c.prepare('INSERT OR REPLACE INTO tick_metrics (ts, session_id) VALUES (?, 1)').run(recent);
  c.prepare('INSERT OR REPLACE INTO rental_samples (rental_id, ts, delivered_th, percent, health) VALUES (5, ?, 1, 1, ?)').run(old, 'x');
  c.prepare('INSERT OR REPLACE INTO market_snapshots (ts, lowest) VALUES (?, 0.0000005)').run(old);
  c.prepare("INSERT INTO sessions (id, mode, state, created_at, started_at) VALUES (9,'quick','ended',?,?)").run(old, old);

  prune.prune(c, now, 90);

  assert.equal(c.prepare('SELECT COUNT(*) n FROM tick_metrics WHERE ts = ?').get(old).n, 0, 'old tick pruned');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM tick_metrics WHERE ts = ?').get(recent).n, 1, 'recent tick kept');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM rental_samples WHERE ts = ?').get(old).n, 0, 'old sample pruned');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM market_snapshots WHERE ts = ?').get(old).n, 0, 'old snapshot pruned');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM sessions WHERE id = 9').get().n, 1, 'sessions kept forever');
});

test('the retention boundary is strict: ts===cutoff is kept, ts===cutoff-1 is pruned', () => {
  const c = db.get();
  const now = 1_900_000_000;
  const cutoff = now - 90 * 86400;
  c.prepare('INSERT OR REPLACE INTO tick_metrics (ts, session_id) VALUES (?, 1)').run(cutoff);
  c.prepare('INSERT OR REPLACE INTO tick_metrics (ts, session_id) VALUES (?, 1)').run(cutoff - 1);
  prune.prune(c, now, 90);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM tick_metrics WHERE ts = ?').get(cutoff).n, 1,
    'ts === cutoff is kept (the delete is `ts < cutoff`, not `<=`)');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM tick_metrics WHERE ts = ?').get(cutoff - 1).n, 0,
    'ts === cutoff-1 is pruned');
});

test('recent rows survive in ALL THREE raw tables, not just tick_metrics', () => {
  const c = db.get();
  const now = 1_950_000_000;
  const recent = now - 5 * 86400;   // well inside the 90-day window
  c.prepare('INSERT OR REPLACE INTO tick_metrics (ts, session_id) VALUES (?, 1)').run(recent);
  c.prepare('INSERT OR REPLACE INTO rental_samples (rental_id, ts, delivered_th, percent, health) VALUES (7, ?, 1, 1, ?)').run(recent, 'x');
  c.prepare('INSERT OR REPLACE INTO market_snapshots (ts, lowest) VALUES (?, 0.0000005)').run(recent);
  prune.prune(c, now, 90);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM tick_metrics WHERE ts = ?').get(recent).n, 1, 'recent tick_metrics kept');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM rental_samples WHERE ts = ?').get(recent).n, 1, 'recent rental_samples kept');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM market_snapshots WHERE ts = ?').get(recent).n, 1, 'recent market_snapshots kept');
});
