-- Which host:port each rental's primary pool (pool/0) points at.
--
-- A rental's pool is written once at creation and then only rewritten by repair passes,
-- and nothing recorded where it pointed. So when the user saved an endpoint on a new host
-- (a new tunnel), running rentals stayed on the old one for the rest of their paid time,
-- and nothing could tell them apart from rentals already on the new one. With the host
-- recorded, the convergence pass (engine/worker-repair.js) moves any running rental whose
-- pool differs from the saved endpoint.
ALTER TABLE rentals ADD COLUMN pool_host TEXT;
ALTER TABLE rentals ADD COLUMN pool_port INTEGER;

-- Rentals already running are taken to be on the endpoint active now, which is the best
-- information there is: endpoint repair and DuckDNS kept them on it. A rental that is in
-- fact still on an older host stays where it is, exactly as before this column existed.
-- Rigs parked on the fallback pool are left NULL: they are deliberately elsewhere.
UPDATE rentals
   SET pool_host = (SELECT p.host FROM pool_endpoints p WHERE p.active = 1 AND p.algo = rentals.algo ORDER BY p.id DESC LIMIT 1),
       pool_port = (SELECT p.port FROM pool_endpoints p WHERE p.active = 1 AND p.algo = rentals.algo ORDER BY p.id DESC LIMIT 1)
 WHERE ended = 0 AND rerouted_ocean = 0;
