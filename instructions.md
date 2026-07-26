# Pickhash

**Rent Bitcoin hashrate on your own terms.**

Pickhash rents SHA-256 (AsicBoost) hashrate from the marketplace and points it at
*your* stratum endpoint — typically your own Bitcoin node behind a Datum Gateway —
so the hashrate you pay for mines *your* block templates.

## First-run setup

Open the **Pickhash** dashboard from your services list. The setup wizard walks you
through everything; you'll need:

1. **A dashboard password.** Set this first — it protects the money-spending controls
   before any marketplace credentials are entered.
2. **Marketplace API credentials.** Create an API key on
   [miningrigrentals.com](https://www.miningrigrentals.com) (Account → API) and paste
   the key and secret. They are encrypted at rest and never leave your server except
   to talk to the marketplace.
3. **Your stratum endpoint.** Where the rented hashrate should point. If you run
   **HashGG** on this server, Pickhash can auto-discover your public endpoint;
   otherwise enter `host:port` manually. If that endpoint is a **raw IP**, Pickhash
   offers to give it a free, stable name via DuckDNS — see *Naming a raw-IP endpoint*
   below.

Once setup is complete, choose a **target hashrate**, a **budget**, and a **duration**,
and Pickhash handles the rest: finding reliable rigs, pricing, creating rentals,
pointing them at your pool, and watching over delivery (ramp-up, under-delivery,
offline rigs, refunds).

## HashGG (optional)

HashGG is listed as an optional companion. It exposes your Datum Gateway stratum port
to the internet so Pickhash can discover your public endpoint automatically. It is not
required — Pickhash works with any reachable `host:port` you enter manually.

## Naming a raw-IP endpoint (DuckDNS)

MiningRigRentals does **not** refund rentals pointed at a bare IP address, so a raw-IP
endpoint leaves you exposed if a rig under-delivers. This mainly affects the **VPS-tunnel**
setup, where your public endpoint is the VPS's own IP. (A HashGG *playit* tunnel already
hands you a hostname, so this won't apply there.)

When the endpoint you test is a raw IP, Pickhash shows a **DuckDNS** option — on by default —
in first-run setup and on **Settings → Stratum endpoint**:

1. Create a free subdomain and copy your token at [duckdns.org](https://www.duckdns.org).
2. Enter the subdomain and token. Pickhash points `<your-subdomain>.duckdns.org` at your
   endpoint's IP, **verifies it resolves**, and then uses the name for all rentals — so the
   marketplace treats it as a hostname (refund-eligible).
3. Pickhash keeps the name in sync: if your VPS IP ever changes, it updates DuckDNS
   automatically, so no rentals need re-pointing.

Your DuckDNS token is encrypted at rest and never leaves your server. If verification fails
(wrong token, or DNS hasn't propagated yet), Pickhash keeps your working raw-IP endpoint and
tells you why — setup is never blocked. You can revert to the raw IP anytime from Settings.

## Notes

- **Backups:** Pickhash's data lives in the packaged volume and is included in your
  StartOS backups. Your marketplace secret is encrypted at rest; on StartOS the
  encryption key lives inside the backup, so the real protection for a stolen backup
  is StartOS's own backup encryption (your master password) — keep it safe.
- **The rental marketplace is a third-party service.** Pickhash stays available even
  when it is temporarily unreachable; the "Rental API Reachable" check is advisory.
- Pickhash spends real Bitcoin on your behalf according to the budget you set. Review
  the budget and guardrails in Settings before enabling autopilot.
