'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');

function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickhash-test-'));
}

test('migrations create the full schema on a fresh database', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    const tables = new Set(
      db.get().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    const expected = [
      'config', 'secrets', 'mrr_nonce', 'sessions', 'rentals', 'rental_samples',
      'tick_metrics', 'decisions', 'alerts', 'rig_scores', 'market_snapshots',
      'pool_endpoints', 'schema_migrations', 'applied_refunds', 'spend_events',
    ];
    for (const t of expected) assert.ok(tables.has(t), `table ${t} exists`);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations are idempotent across reopen', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    db.close();
    // Reopening the same data dir must not throw and must not re-run migrations.
    db.open(dir);
    const n = db.get().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    assert.ok(n >= 1, 'at least one migration recorded');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a partially-applied multi-ALTER migration re-adds only the missing columns', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);                             // 003 fully applied (4 columns)
    // Simulate a migration that half-applied on an older run: one of its ALTERs landed,
    // the rest did not, and it was never stamped. Reopening must fill only the gap.
    db.get().prepare("DELETE FROM schema_migrations WHERE filename = '003_rental_diff_telemetry.sql'").run();
    db.get().exec('ALTER TABLE rentals DROP COLUMN diff_in_range');
    db.close();
    db.open(dir);                             // 003 re-runs: existing ALTERs dup-throw, gap re-added
    const cols = new Set(db.get().prepare('PRAGMA table_info(rentals)').all().map((r) => r.name));
    assert.ok(cols.has('diff_in_range'), 'the missing column was re-added, not skipped as "already done"');
    assert.ok(cols.has('endpoint_diff'), 'the already-present columns survived');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 004 creates applied_refunds keyed by tx_id', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    const tables = new Set(
      db.get().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    assert.ok(tables.has('applied_refunds'), 'applied_refunds table exists');
    const cols = db.get().prepare('PRAGMA table_info(applied_refunds)').all();
    const pk = cols.filter((c) => c.pk > 0);
    assert.equal(pk.length, 1, 'exactly one primary-key column');
    assert.equal(pk[0].name, 'tx_id', 'tx_id is the primary key (the idempotency guard)');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 005 creates the dashboard-poll covering indexes by name', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    const idx = new Set(
      db.get().prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name),
    );
    // Named explicitly so a rename/drop can't slip through unnoticed.
    assert.ok(idx.has('idx_tick_metrics_session_ts'), 'tick_metrics (session_id, ts) index exists');
    assert.ok(idx.has('idx_rental_samples_ts'), 'rental_samples (ts) index exists');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 006 creates spend_events with its ts index', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    const tables = new Set(
      db.get().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    assert.ok(tables.has('spend_events'), 'spend_events table exists');
    const idx = new Set(
      db.get().prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name),
    );
    // Named explicitly — the rolling daily ceiling / pacing keys read spend_events by ts.
    assert.ok(idx.has('idx_spend_events_ts'), 'spend_events (ts) index exists');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('open enables WAL journaling and foreign key enforcement', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    const journal = db.get().prepare('PRAGMA journal_mode').get().journal_mode;
    assert.equal(String(journal).toLowerCase(), 'wal');
    const fk = db.get().prepare('PRAGMA foreign_keys').get().foreign_keys;
    assert.equal(fk, 1);
    // A rental referencing a non-existent session must be rejected (FK on).
    assert.throws(
      () => db.get().prepare('INSERT INTO rentals (session_id, mrr_id) VALUES (999, 1)').run(),
      /FOREIGN KEY/i,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('get() throws before open; close() is idempotent', () => {
  const dir = freshDataDir();
  try {
    db.close();                               // safe even when nothing is open
    assert.throws(() => db.get(), /not open/);
    db.open(dir);
    assert.ok(db.get());
    db.close();
    db.close();                               // double close is a no-op
    assert.throws(() => db.get(), /not open/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-heals a pre-tracking database (already-exists path stamps, does not throw)', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);                             // full schema + stamped
    // Simulate a database created before migration tracking existed: drop the ledger
    // but keep all the real tables.
    db.get().exec('DROP TABLE schema_migrations');
    db.close();
    // Re-open: the migration re-runs, hits "table already exists", rolls back cleanly,
    // and stamps itself — no crash-loop, schema intact.
    db.open(dir);
    const tables = new Set(
      db.get().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    assert.ok(tables.has('config') && tables.has('rentals'), 'schema still intact');
    const n = db.get().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    assert.ok(n >= 1, 'migration re-stamped');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 012 records each running rental on the active endpoint of its algorithm', () => {
  const dir = freshDataDir();
  try {
    db.open(dir);
    const c = db.get();
    // Roll back to just before 012, with a running session on a BLAKE2b endpoint.
    c.prepare("DELETE FROM schema_migrations WHERE filename = '012_rental_pool_host.sql'").run();
    c.exec('ALTER TABLE rentals DROP COLUMN pool_host');
    c.exec('ALTER TABLE rentals DROP COLUMN pool_port');
    c.prepare("INSERT INTO pool_endpoints (algo, host, port, worker_base, active) VALUES ('blake2b', 'old.gg', 1111, 'bc1qx', 0)").run();
    c.prepare("INSERT INTO pool_endpoints (algo, host, port, worker_base, active) VALUES ('blake2b', 'tunnel.gg', 2222, 'bc1qx', 1)").run();
    const sid = Number(c.prepare("INSERT INTO sessions (algo, mode, state, created_at, started_at) VALUES ('blake2b','autopilot','active',1,1)").run().lastInsertRowid);
    const ins = c.prepare(`INSERT INTO rentals (algo, session_id, mrr_id, rig_id, advertised_th, length_hours, paid_sats, fee_sats,
                                                start_ts, end_ts, ended, health, rerouted_ocean)
                           VALUES ('blake2b', ?, ?, 1, 1, 3, 1, 1, 1, 9, ?, 'healthy', ?)`);
    ins.run(sid, 1, 0, 0);   // running
    ins.run(sid, 2, 1, 0);   // ended: history, left alone
    ins.run(sid, 3, 0, 1);   // parked on the fallback pool: deliberately elsewhere
    db.close();
    db.open(dir);
    const rows = Object.fromEntries(db.get().prepare('SELECT mrr_id, pool_host, pool_port FROM rentals').all().map((r) => [r.mrr_id, r]));
    assert.equal(rows[1].pool_host, 'tunnel.gg');
    assert.equal(rows[1].pool_port, 2222);
    assert.equal(rows[2].pool_host, null);
    assert.equal(rows[3].pool_host, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
