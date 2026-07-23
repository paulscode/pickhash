-- Dated ledger of autonomous MRR spends (rentals created + extensions), so the rolling
-- daily ceiling and rent pacing key on WHEN money was actually spent — not on a rental's
-- start_ts (an extension bumps paid_sats without moving start_ts, which let extends of an
-- old rental escape max_daily_spend_sats and the pacing clock entirely).
CREATE TABLE IF NOT EXISTS spend_events (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,        -- unix seconds the spend occurred
  sats       INTEGER NOT NULL,        -- fee-inclusive amount
  kind       TEXT,                    -- 'rent' | 'extend'
  session_id INTEGER,
  mrr_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spend_events_ts ON spend_events (ts);
