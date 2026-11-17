-- The dashboard polls /api/status continuously, and in DRY-RUN it reads the session's latest
-- rehearsed plan back out of decisions. Decisions are kept for good as the audit trail, so
-- without an index on the session every poll would scan the whole table.
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions (session_id, dry_run, ts);
