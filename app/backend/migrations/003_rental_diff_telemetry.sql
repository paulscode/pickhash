-- Diff telemetry: capture, per rental, the pool difficulty the rig saw and the rig's
-- optimal_diff range at rent time. Paired with rentals.avg_percent (the delivered
-- outcome), this lets us later measure — from real rentals — whether being outside a
-- rig's optimal difficulty range actually affects delivery, before deciding to weight it
-- in ranking. The self-healing runner tolerates a re-applied ALTER on older DBs.
ALTER TABLE rentals ADD COLUMN endpoint_diff REAL;
ALTER TABLE rentals ADD COLUMN optimal_diff_min REAL;
ALTER TABLE rentals ADD COLUMN optimal_diff_max REAL;
ALTER TABLE rentals ADD COLUMN diff_in_range INTEGER;
