-- Alerts are keyed by (kind, subject) for transition lookups (e.g. one
-- rental_underdelivering per rental). The self-healing runner tolerates a
-- re-applied ALTER (duplicate-column) on older DBs.
ALTER TABLE alerts ADD COLUMN key TEXT;
CREATE INDEX IF NOT EXISTS idx_alerts_kind_key_state ON alerts (kind, key, state);
