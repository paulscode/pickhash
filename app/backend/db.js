'use strict';
/**
 * SQLite access + migration runner.
 *
 * One database, one writer (the whole app is a single process); WAL mode so the UI
 * can read while the control loop writes. Money and audit records live here, so on
 * shutdown we checkpoint the WAL back into the main file for clean backups.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let db = null;

/** Open (or create) the database, apply migrations, and return the connection. */
function open(dataDir) {
  const file = path.join(dataDir, 'pickhash.db');
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  db = database;
  runMigrations(database);
  return database;
}

/** The open connection. Throws if the database hasn't been opened yet. */
function get() {
  if (!db) throw new Error('database not open');
  return db;
}

/**
 * Apply sequential .sql migrations from ./migrations, once each, in filename order.
 * Self-healing: if a migration fails only because an object already exists (e.g. a
 * database created before this tracking table, or a half-applied interrupted run),
 * record it as applied instead of crash-looping on every boot.
 */
function runMigrations(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    database.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
  );
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // Wrap each migration in a transaction so it applies all-or-nothing: a real
    // failure rolls back cleanly (retried next boot) instead of leaving a partially
    // applied file that a later "already exists" pass would wrongly stamp as done.
    try {
      database.exec('BEGIN');
      database.exec(sql);
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* no active transaction */ }
      if (!isAlreadyExists(err)) throw err;
      // Some objects already exist (e.g. a multi-ALTER batch where a subset is present).
      // The rollback undid the good statements too, so re-apply each statement on its own,
      // skipping only the ones that already exist — never stamp a batch with missing DDL.
      // Strip `-- ...` line comments first: a comment may contain a `;` (prose), and a
      // naive split would expose the tail as bogus SQL. Our migrations never put `--` or
      // `;` inside a string literal, so line-based stripping is safe here.
      const bare = sql.replace(/--[^\n]*/g, '');
      for (const stmt of bare.split(';').map((s) => s.trim()).filter(Boolean)) {
        try { database.exec(stmt); } catch (e2) { if (!isAlreadyExists(e2)) throw e2; }
      }
    }
    database.prepare('INSERT OR IGNORE INTO schema_migrations (filename, applied_at) VALUES (?, ?)')
      .run(file, nowSeconds());
  }
}

function isAlreadyExists(err) {
  const m = String(err && err.message).toLowerCase();
  return m.includes('already exists') || m.includes('duplicate column');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Checkpoint the WAL into the main db file and close cleanly. Call on SIGTERM so a
 * backup taken while the container is stopped sees a self-contained .db file.
 */
function close() {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  try { db.close(); } catch { /* already closed */ }
  db = null;
}

module.exports = { open, get, close, runMigrations };
