# Security Policy

Pickhash holds spend authority over real Bitcoin, so we take security seriously and welcome reports.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through one of these channels:

- **GitHub private advisory** — on the repository, go to the **Security** tab → **Report a
  vulnerability** (GitHub private vulnerability reporting). This is preferred.
- **Email** — <paul@paulscode.com>.

Please include enough to reproduce: affected version or commit, environment (Docker / StartOS), steps,
and the impact you observed. If you have a suggested fix, that's welcome too.

We aim to acknowledge a report within a few days and to keep you updated as we investigate. Please give
us reasonable time to release a fix before any public disclosure. We're happy to credit reporters who
want it.

## Supported versions

Pickhash is pre-1.0 and under active development. Security fixes target the latest `main` and the most
recent release. Please test against current `main` before reporting where practical.

## Security posture

These properties are built into the app. They're summarized here so reporters know the intended
behavior; a deviation from any of them is worth reporting.

- **A dashboard password is required before the app can spend.** Storing marketplace credentials,
  switching from DRY-RUN to LIVE, and probing arbitrary endpoints all require the password (or a
  managed-password mode provided by the hosting platform). The safe rehearsal mode, DRY-RUN, is the
  default and works without one.
- **Marketplace credentials are encrypted at rest** with AES-256-GCM, with the field name bound as
  additional authenticated data. The encryption key is held outside the database (a `0600` key file,
  or derived from a platform-provided seed) and credentials are never written to logs.
- **Marketplace calls are HTTPS-only** and HMAC-signed with a persisted, monotonically increasing
  nonce, so requests can't be trivially replayed. A plaintext endpoint override is refused unless an
  explicit test-only opt-in is set.
- **SSRF defense on user-supplied endpoints.** Hostnames are resolved and every resolved address is
  checked against blocked ranges (link-local, cloud metadata, multicast, and embedded-IPv4 forms)
  before connecting, then pinned to the validated IP. Loopback and private/LAN ranges are
  intentionally allowed, because the mining target is normally a node on the same network.
- **Fund-moving operations are never retried on an ambiguous outcome** (a timeout or unclear response
  is treated as "unknown," not "do it again").
- **The container runs as a non-root user** and fails closed — it exits rather than continue running
  as root unless explicitly overridden.
- **Web hardening:** a strict Content-Security-Policy, `HttpOnly` / `SameSite=Lax` session cookies
  (with `Secure` on TLS transports), CSRF tokens on state-changing requests, a required JSON
  content-type on mutations, explicit HTTP timeouts, and a persisted global rate-limit on failed
  logins.

## Backups — important

Your Pickhash data (including your encrypted marketplace credentials) is included in your platform's
backups.

- **On StartOS**, the encryption key is stored *inside* the backed-up volume. This means the at-rest
  encryption does **not**, by itself, protect a stolen StartOS backup — the real protection there is
  StartOS's own backup encryption, i.e. your StartOS master password. Keep it strong and safe.
- **On the Docker path**, protect your `data/` directory: it holds both the encryption key and the
  encrypted credentials. Anyone with read access to that directory can decrypt your credentials.

## Scope

In scope: the Pickhash application and its packaging (Docker, StartOS). Out of scope: the
MiningRigRentals marketplace itself, StartOS/Umbrel platform internals, and third-party dependencies of
those platforms — please report those to their respective maintainers.
