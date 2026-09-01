-- Per-rig share difficulty, requested through the Stratum password.
--
-- MRR scores a rental on the hashrate it measures from accepted shares, so a rig left
-- at a difficulty far above its size produces too few shares to measure well, and a
-- refund claim on a rental that really did work gets declined. The rig's own published
-- optimal_diff fixes that, but only if we can tell the pool about it, and the password
-- is the only field a rental passes through to the pool verbatim.
--
-- stratum_pass records what was actually sent for each rental. The DuckDNS repoint
-- paths rewrite pool/0 on live rentals, and without the value stored they would rewrite
-- the password back to 'x' and silently undo the difficulty mid-rental.
ALTER TABLE rentals ADD COLUMN stratum_pass TEXT;

-- Whether this endpoint was observed to honour a difficulty request. Detected by
-- probing, not assumed: a stock DATUM Gateway discards the password entirely, and an
-- endpoint that ignores it must not have per-rig difficulty recorded as if it applied.
-- NULL means never tested, which is distinct from tested-and-unsupported.
ALTER TABLE pool_endpoints ADD COLUMN supports_password_diff INTEGER;
