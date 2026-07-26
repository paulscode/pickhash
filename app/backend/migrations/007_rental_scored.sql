-- Make rig scoring self-healing. The score fold in observe only fires the single tick a rental
-- transitions active->ended, so any rental that reached ended=1 by another path -- one that ended
-- before the scoring feature existed, or a process death between the ended=1 commit and the fold --
-- was never folded, leaving its rig UNSCORED. An unscored rig defaults to expectedDelivery 1.0 and
-- can be re-rented even after it delivered 0% (exactly what let a dead rig get rented twice).
--
-- `scored` marks which ended rentals are already reflected in rig_scores, so a backfill sweep can
-- fold the stragglers idempotently.
ALTER TABLE rentals ADD COLUMN scored INTEGER DEFAULT 0;

-- Recompute rig_scores authoritatively from the FULL rental history, so it no longer depends on
-- having caught every live end-edge: mean delivery (a null final % counts as 0, the worst case),
-- offline incidents (<10%), rental count, and the latest price/end. This retroactively scores rigs
-- that ended before scoring existed -- good performers earn their ranking, dead ones are penalized.
-- blacklisted/note are reset to their defaults: the operative blacklist lives in strategy config,
-- and these rig_scores columns are unused.
DELETE FROM rig_scores;
INSERT INTO rig_scores (rig_id, rentals, mean_percent, offline_incidents, last_price, last_seen, blacklisted, note)
SELECT r.rig_id,
       COUNT(*),
       AVG(CASE WHEN r.avg_percent IS NULL THEN 0 ELSE r.avg_percent END),
       SUM(CASE WHEN COALESCE(r.avg_percent, 0) < 10 THEN 1 ELSE 0 END),
       (SELECT r2.rate_btc_th_day FROM rentals r2 WHERE r2.rig_id = r.rig_id AND r2.ended = 1 ORDER BY r2.end_ts DESC, r2.id DESC LIMIT 1),
       MAX(r.end_ts),
       0, NULL
FROM rentals r
WHERE r.ended = 1 AND r.rig_id IS NOT NULL
GROUP BY r.rig_id;

-- Everything ended so far is now reflected above -> mark it scored so the sweep only folds new ends.
UPDATE rentals SET scored = 1 WHERE ended = 1;
