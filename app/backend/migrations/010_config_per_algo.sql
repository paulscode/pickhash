-- Give the config table the same algorithm dimension the data tables got in 009.
--
-- 009 stopped two algorithms' rows from blending. This stops their settings from
-- blending, which is the same problem one level up: a spend ceiling or a price cap
-- set against one market is not merely a poor fit for the other, it is wrong by
-- three orders of magnitude. Left shared, the guardrails a user tuned for sha256ab
-- would silently govern blake2b spending, and a ceiling that never triggers looks
-- exactly like a ceiling that is working.
--
-- Not every namespace is per-algorithm. `strategy` and `guardrails` are, because
-- they describe how to spend money in a particular market. `ui` is too, because its
-- one knob is the primary hashrate unit and the two markets differ in scale by five
-- orders of magnitude: PH is the natural unit for sha256ab and absurd for blake2b,
-- whose entire available supply is around 136 TH.
--
-- `notifications` and `duckdns` are not: a DNS name has nothing to do with which
-- algorithm is being rented, and splitting them would mean a user who switches
-- algorithms loses their DuckDNS setup. Global rows carry algo = '', which is not a
-- valid slug and so can never be confused for one.
--
-- Existing rows are all from the sha256ab era, so the scoped namespaces are
-- relabelled to it and everything else becomes global.

-- Renamed aside first, for the reason given in 009: the runner retries a failed
-- batch statement by statement, so a previous attempt can leave _pre010 behind, and
-- taking that name first makes the retry stop on the debris rather than build on it.
--
-- As in 009, that ordering does not make a re-run against a cleanly-migrated
-- database safe. The copy below re-derives algo from the namespace, so a second run
-- would move every scoped row back to sha256ab; where both algorithms had settings
-- for a namespace the two would collide on the new primary key and the run would
-- fail partway. What actually prevents a re-run is the runner recording a migration
-- inside the transaction that applies it.
ALTER TABLE config RENAME TO config_pre010;

CREATE TABLE config (
  ns          TEXT NOT NULL,
  -- '' means the namespace is global. Never a real slug, so a global row cannot be
  -- mistaken for one algorithm's settings.
  algo        TEXT NOT NULL DEFAULT '',
  json        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ns, algo)
);

INSERT INTO config (ns, algo, json, updated_at)
  SELECT ns,
         CASE WHEN ns IN ('strategy', 'guardrails', 'ui') THEN 'sha256ab' ELSE '' END,
         json,
         updated_at
  FROM config_pre010;

DROP TABLE config_pre010;
