-- Initial schema.
-- Conventions: timestamps are unix seconds (INTEGER); money is integer satoshis;
-- hashrate is REAL TH/s; anything still evolving goes in a JSON TEXT column.

CREATE TABLE config        (ns TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- Encrypted credential blobs. AES-256-GCM; the row name is the GCM additional
-- authenticated data, so a blob can't be swapped between fields.
CREATE TABLE secrets       (name TEXT PRIMARY KEY, blob BLOB NOT NULL, updated_at INTEGER NOT NULL);

-- Single monotonic nonce counter for the rental API (one sequence per key).
CREATE TABLE mrr_nonce     (id INTEGER PRIMARY KEY CHECK (id=1), nonce INTEGER NOT NULL);

CREATE TABLE sessions      (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, state TEXT NOT NULL,
                            target_th REAL, budget_sats INTEGER, duration_hours REAL, time_cap_hours REAL,
                            spent_sats INTEGER DEFAULT 0, fee_sats INTEGER DEFAULT 0,
                            created_at INTEGER, started_at INTEGER, ended_at INTEGER, summary_json TEXT);

CREATE TABLE rentals       (id INTEGER PRIMARY KEY, session_id INTEGER REFERENCES sessions(id),
                            mrr_id INTEGER UNIQUE, rig_id INTEGER, rig_name TEXT, region TEXT,
                            advertised_th REAL, length_hours REAL, paid_sats INTEGER, fee_sats INTEGER,
                            rate_btc_th_day REAL, start_ts INTEGER, end_ts INTEGER,
                            health TEXT NOT NULL DEFAULT 'pending',  -- pending|ramping|healthy|degraded|offline|ended
                            avg_percent REAL, ended INTEGER DEFAULT 0, refunded INTEGER DEFAULT 0,
                            refund_sats INTEGER DEFAULT 0, refund_watch_until INTEGER,  -- post-session refund reconciliation
                            dispute_deadline INTEGER, evidence_json TEXT, worker_name TEXT);

CREATE TABLE rental_samples(rental_id INTEGER, ts INTEGER, delivered_th REAL, percent REAL, health TEXT,
                            PRIMARY KEY (rental_id, ts));

CREATE TABLE tick_metrics  (ts INTEGER PRIMARY KEY, session_id INTEGER, delivered_th REAL, target_th REAL,
                            active_rentals INTEGER, spent_sats INTEGER, balance_confirmed_sats INTEGER,
                            balance_unconfirmed_sats INTEGER, market_lowest REAL, market_last10 REAL,
                            endpoint_ok INTEGER, mrr_ok INTEGER, hashgg_ok INTEGER);

CREATE TABLE decisions     (id INTEGER PRIMARY KEY, ts INTEGER, session_id INTEGER, dry_run INTEGER,
                            observed_json TEXT, proposed_json TEXT, gated_json TEXT, executed_json TEXT, note TEXT);

CREATE TABLE alerts        (id INTEGER PRIMARY KEY, kind TEXT, severity TEXT, state TEXT, -- armed|fired|resolved|acked
                            armed_at INTEGER, fired_at INTEGER, resolved_at INTEGER, acked_at INTEGER,
                            context_json TEXT);

CREATE TABLE rig_scores    (rig_id INTEGER PRIMARY KEY, rentals INTEGER DEFAULT 0, mean_percent REAL,
                            offline_incidents INTEGER DEFAULT 0, last_price REAL, last_seen INTEGER,
                            blacklisted INTEGER DEFAULT 0, note TEXT);

CREATE TABLE market_snapshots (ts INTEGER PRIMARY KEY, lowest REAL, last10 REAL, last REAL,
                            available_rigs INTEGER, available_th REAL, depth_json TEXT);

CREATE TABLE pool_endpoints(id INTEGER PRIMARY KEY, name TEXT, source TEXT, host TEXT, port INTEGER,
                            worker_base TEXT, mrr_pool_id INTEGER, mrr_profile_id INTEGER,
                            stratum_diff REAL,  -- captured from the pool compatibility test; feeds rig-search difficulty match
                            last_test_json TEXT, active INTEGER DEFAULT 0);
