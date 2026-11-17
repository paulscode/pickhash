-- What the endpoint's Datum Gateway said it supports, as the JSON of gateway.assess() plus
-- when it was checked.
--
-- Recorded at the endpoint test and refreshed periodically by the engine, so the Settings
-- page can show it and the gateway_outdated alert can clear by itself once the user installs
-- a Gateway that serves rented rigs below the pool's minimum difficulty. NULL: never checked.
ALTER TABLE pool_endpoints ADD COLUMN gateway_json TEXT;
