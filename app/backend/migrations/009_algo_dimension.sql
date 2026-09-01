-- Add the algorithm dimension.
--
-- Until now the app could only rent one algorithm, so every row implicitly meant
-- sha256ab and nothing needed to say so. With a second algorithm the scales are not
-- comparable: measured from the live API, a TH of blake2b costs about 2,425x a TH of
-- sha256ab, from a market about 269,000x smaller. Mixing them in one chart or one
-- SUM() produces a number that looks reasonable and means nothing.
--
-- Existing rows are all sha256ab, which is why the default backfills rather than
-- being left null.
--
-- The default also keeps this migration behaviour-neutral: every existing writer
-- inserts without naming an algorithm and keeps working. That is deliberate for
-- now and not the end state. Once the write paths name the algorithm explicitly,
-- the default is what would let a new writer forget to, so it should be dropped
-- then rather than left as a permanent fallback.

ALTER TABLE sessions        ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE rentals         ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE rental_samples  ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE decisions       ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE alerts          ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE rig_scores      ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE pool_endpoints  ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE spend_events    ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';
ALTER TABLE applied_refunds ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256ab';

-- market_snapshots and tick_metrics keyed on ts alone, which two algorithms would
-- collide on: both record a row per tick, so the second writer of any given second
-- would replace the first rather than sit beside it. SQLite cannot alter a primary
-- key in place, so these are rebuilt.
--
-- Renamed aside first rather than built-then-dropped. The runner rolls a failed
-- batch back and then retries it one statement at a time, skipping anything that
-- already exists, so a previous attempt can leave the _pre009 table behind; taking
-- that name first makes the retry stop on the debris instead of building on top of
-- it.
--
-- Be clear about what that does NOT protect, because an earlier version of this
-- comment claimed more. If this migration is ever re-run against a database where
-- it already completed cleanly, the _pre009 name is free again and every statement
-- succeeds: the copy below forces algo to 'sha256ab', so any blake2b rows would be
-- silently relabelled. Statement ordering cannot prevent that. What prevents it is
-- that the runner records a migration as applied inside the same transaction that
-- applies it, so there is no window where the effect survives without the record.
-- See runMigrations in db.js.
ALTER TABLE market_snapshots RENAME TO market_snapshots_pre009;
CREATE TABLE market_snapshots (
  algo            TEXT NOT NULL DEFAULT 'sha256ab',
  ts              INTEGER NOT NULL,
  lowest          REAL,
  last10          REAL,
  last            REAL,
  available_rigs  INTEGER,
  available_th    REAL,
  depth_json      TEXT,
  PRIMARY KEY (algo, ts)
);
INSERT INTO market_snapshots (algo, ts, lowest, last10, last, available_rigs, available_th, depth_json)
  SELECT 'sha256ab', ts, lowest, last10, last, available_rigs, available_th, depth_json
  FROM market_snapshots_pre009;
DROP TABLE market_snapshots_pre009;

ALTER TABLE tick_metrics RENAME TO tick_metrics_pre009;
CREATE TABLE tick_metrics (
  algo                      TEXT NOT NULL DEFAULT 'sha256ab',
  ts                        INTEGER NOT NULL,
  session_id                INTEGER,
  delivered_th              REAL,
  target_th                 REAL,
  active_rentals            INTEGER,
  spent_sats                INTEGER,
  balance_confirmed_sats    INTEGER,
  balance_unconfirmed_sats  INTEGER,
  market_lowest             REAL,
  market_last10             REAL,
  endpoint_ok               INTEGER,
  mrr_ok                    INTEGER,
  hashgg_ok                 INTEGER,
  PRIMARY KEY (algo, ts)
);
INSERT INTO tick_metrics (algo, ts, session_id, delivered_th, target_th, active_rentals,
  spent_sats, balance_confirmed_sats, balance_unconfirmed_sats, market_lowest, market_last10,
  endpoint_ok, mrr_ok, hashgg_ok)
  SELECT 'sha256ab', ts, session_id, delivered_th, target_th, active_rentals,
    spent_sats, balance_confirmed_sats, balance_unconfirmed_sats, market_lowest, market_last10,
    endpoint_ok, mrr_ok, hashgg_ok
  FROM tick_metrics_pre009;
DROP TABLE tick_metrics_pre009;

-- 005 created this on the old table; the rebuild dropped it.
CREATE INDEX IF NOT EXISTS idx_tick_metrics_session_ts ON tick_metrics (session_id, ts);

-- Every scoped read filters on algo, so give each table an index that leads with it.
CREATE INDEX IF NOT EXISTS idx_rentals_algo        ON rentals (algo);
CREATE INDEX IF NOT EXISTS idx_sessions_algo       ON sessions (algo);
CREATE INDEX IF NOT EXISTS idx_pool_endpoints_algo ON pool_endpoints (algo);
CREATE INDEX IF NOT EXISTS idx_alerts_algo         ON alerts (algo);
CREATE INDEX IF NOT EXISTS idx_spend_events_algo   ON spend_events (algo, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_algo      ON decisions (algo, ts);
