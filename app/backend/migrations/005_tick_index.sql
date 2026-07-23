-- Cover the /api/metrics per-session scan (was a full table scan on the ts-only PK) and
-- the per-rental sample lookups. Keeps dashboard polls cheap as tick_metrics grows.
CREATE INDEX IF NOT EXISTS idx_tick_metrics_session_ts ON tick_metrics (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_rental_samples_ts ON rental_samples (ts);
