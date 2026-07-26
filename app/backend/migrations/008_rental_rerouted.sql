-- Marks a rental that proactive dead-rig fallback has moved to the Ocean pool, so nothing fights
-- over its pool/0: endpoint-repair skips it (won't yank it back to your endpoint) and owner-nudge
-- skips it (the reroute already messaged the owner). Also makes the reroute once-per-rental.
ALTER TABLE rentals ADD COLUMN rerouted_ocean INTEGER DEFAULT 0;
