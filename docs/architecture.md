# Architecture

This document is for developers. It explains how Pickhash is put together, the design constraints that
shaped it, and where to find things. For a plain-language tour of what the app *does*, see
[how-it-works.md](how-it-works.md).

## Design constraints

Three constraints drive most of the decisions in this codebase:

1. **Zero runtime dependencies.** The backend imports only the Node.js standard library —
   `node:http`, `node:sqlite`, `node:crypto`, `fetch`, `node:test`, and friends. There is no
   `node_modules` at runtime and no package to audit or update besides Node itself. This requires
   **Node.js 24+** (the built-in SQLite module, `node:sqlite`, is what makes a dependency-free
   database possible).

2. **It spends real money, so it fails safe.** Every path that could move funds is gated, defaults to
   a no-op, and never retries an operation whose outcome is ambiguous. DRY-RUN is the default mode;
   LIVE is a deliberate, password-gated switch.

3. **It runs unattended on someone's home server.** The control loop must survive a flaky third-party
   marketplace, restarts, and clock skew without losing money or getting stuck. State lives in SQLite
   so a restart resumes cleanly.

CommonJS throughout the backend. The frontend is a single-page app built on a strict
Content-Security-Policy (details below).

## Big picture

```
                    ┌──────────────────────────────────────────┐
   Browser  ─────►  │  server.js  (node:http, static + JSON API)│
   (Alpine SPA)     │    ├─ auth.js      session + CSRF + lockout│
                    │    ├─ api.js       request routing          │
                    │    └─ secrets.js   AES-256-GCM at rest       │
                    └───────────────┬──────────────────────────┘
                                    │  shared SQLite (node:sqlite)
                    ┌───────────────┴──────────────────────────┐
   Tick (60s) ────► │  engine/loop.js → runner.js               │
                    │    observe → decide → gate → execute       │
                    │    + accounting, health, refunds, prune…   │
                    └───────────────┬──────────────────────────┘
                                    │  fetch (HTTPS, HMAC-signed)
                                    ▼
                       MiningRigRentals marketplace API
                                    │
                                    ▼
                    rented rigs ──► your stratum endpoint
```

The HTTP server and the autopilot engine run in the same process and share one SQLite database. The
server handles the dashboard and the API; the engine runs a periodic tick that does the autonomous
work.

## The control loop

The heart of the app is a tick loop (default 60s, in `engine/loop.js`) that drives each active session
through four stages. Keeping these stages separate is what makes the engine testable and safe:

- **observe** (`engine/observe.js`) — gather ground truth: current balance, live rentals and their
  delivery, endpoint reachability. Read-only; it never mutates the marketplace. Endpoint probes
  resolve and pin the target IP first (see *Security model*).
- **decide** (`engine/decide.js`, with `scoring.js`, `quote.js`, `adopt.js`, `extend.js`) — compute
  what *should* happen: which rigs to rent, which to extend, whether to top up toward target. Pure
  planning; produces a plan, spends nothing.
- **gate** (`engine/gate.js`) — the safety checkpoint. The plan is checked against every guardrail:
  session budget, max-session budget, the rolling 24-hour spend cap, price ceilings, affordable
  balance, and run-mode (DRY-RUN vs LIVE). Anything that fails is dropped here, before any call that
  costs money.
- **execute** (`engine/execute.js`) — carry out the approved plan against the marketplace. In DRY-RUN
  this is a no-op that records what *would* have happened. Mutations are never retried on an ambiguous
  result (a timeout or unclear response is treated as "unknown," not "retry").

Supporting engine modules run alongside the loop:

- `accounting.js`, `ledger.js`, `spend`-tracking — real cost reconciliation and the 24h rolling cap.
- `health.js`, `delivery/` — per-rental delivery percentage and health classification; the
  `delivery/mrr-source.js` adapter isolates the marketplace's data shape.
- `refunds.js`, `dispute.js` — track the marketplace's automatic under-delivery refunds and surface a
  dispute path only when the automatic one doesn't land.
- `endpoint-repair.js` — re-points rentals if the target endpoint changes (validated + IP-pinned).
- `owner-nudge.js`, `messaging.js` (backend) — opt-in owner-facing nudges on sustained under-delivery.
- `prune.js` — retire finished/expired sessions and tidy state.
- `runner.js` — orchestrates one tick across all of the above.

## Backend module map

Top-level `app/backend/`:

| Module | Responsibility |
| --- | --- |
| `server.js` | `node:http` server: static serving (path-traversal-safe), security headers/CSP, request timeouts, non-root privilege drop, JSON API dispatch. |
| `api.js` | Route table for the JSON API; per-route auth + money-route gating. |
| `auth.js` | Password sessions, CSRF tokens, shared persisted login lockout, managed-password mode. |
| `secrets.js` | AES-256-GCM encryption at rest; scrypt password hashing (versioned); key material management. |
| `db.js` | SQLite open/migrate/close; the migrations in `migrations/` run on open. |
| `config.js` | Typed key/value config with defaults (stored `null` never masks a non-null default). |
| `mrr.js`, `mrr-client.js` | Marketplace client: HMAC-SHA1 request signing, persisted monotonic nonce, HTTPS-only base URL. |
| `endpoint.js` | Stratum endpoint parsing + SSRF defense (`isBlockedIp`, `resolvePinnedIp`). |
| `stratum.js` | Minimal stratum probe (is the endpoint alive and accepting work?). |
| `hashgg.js` | Optional HashGG companion discovery of the user's public endpoint. |
| `quote.js`, `quote-service.js` | The three-linked-numbers math (spend ↔ hashrate ↔ duration) and live quoting. |
| `session.js` | Session lifecycle; quick-rent execution with the daily cap applied. |
| `market.js`, `charts.js` | Market depth / price history and server-side chart geometry. |
| `deposit.js` | Deposit-address surfacing and balance handling. |
| `alerts.js` | Operator-facing alerts. |
| `units.js` | Hashrate/price unit formatting (tuned for single-digit PH/s users). |
| `bootstrap.js` | First-run/setup state. |

`app/backend/engine/` holds the loop modules listed above. `app/backend/test/` holds the test suite.
`app/backend/migrations/` holds the ordered SQL migrations.

## Data model

SQLite, opened via `node:sqlite`, migrated forward by the numbered files in `migrations/`
(`001_init.sql` … `006_spend_events.sql`). Notable tables cover sessions, rentals, the applied-refund
ledger, rental-diff telemetry, spend events (for the rolling cap), and config. Migrations are additive
and run automatically on `db.open()`.

## Security model

Because the app holds spend authority, several properties are enforced structurally, not by
convention:

- **Password required before spend.** Storing marketplace credentials, switching to LIVE, and probing
  arbitrary endpoints all require a dashboard password (or managed-password mode on a hosting
  platform). DRY-RUN works without one.
- **Secrets encrypted at rest.** Marketplace key/secret are stored AES-256-GCM with the field name
  bound as AAD; the key lives outside the database (a `secret.key` file at `0600`, or derived from a
  platform-provided seed). Secrets are never logged.
- **HTTPS-only marketplace calls**, HMAC-SHA1 signed with a persisted monotonic nonce so a signature
  can't be replayed; `baseUrl()` refuses a plaintext override unless an explicit test opt-in is set.
- **SSRF defense.** Any user-supplied endpoint is resolved and every resolved address is validated
  against blocked ranges (link-local, cloud metadata, multicast, and various embedded-IPv4 forms),
  then pinned to the checked IP before connecting. Loopback and private ranges are intentionally
  allowed — the target is usually a node on the same LAN.
- **Non-root, fail-closed.** The container drops to an unprivileged user (setgroups + setgid + setuid)
  and exits rather than continuing as root unless explicitly overridden.
- **Web hardening.** Strict CSP, `HttpOnly`/`SameSite=Lax` (and `Secure` on TLS) session cookies,
  CSRF tokens on mutations, `Content-Type: application/json` required on mutating requests, explicit
  HTTP timeouts, and a persisted global login lockout.

See [SECURITY.md](../SECURITY.md) for the reporting policy and the user-facing summary.

## Frontend

`app/frontend/` is a single HTML page (`index.html`) plus `app.js`, styled with a prebuilt Tailwind
CSS bundle (`dashboard.min.css`, committed; regenerate with `make css`). It runs under a strict
Content-Security-Policy, which imposes real constraints:

- **Alpine.js CSP build.** Directives may only use bare property access, method calls, and the unary
  `!`. No operators, ternaries, or template literals in markup — compute anything more complex in
  `app.js` or server-side.
- **Untrusted strings go through `x-text`**, never `x-html` or interpolation.
- **No `<template x-for>` inside `<svg>`.** Chart geometry is computed server-side (`charts.js`) and
  axis labels are rendered as HTML overlays.

Vendored, SRI-pinned third-party assets live in `app/frontend/vendor/`.

## Packaging

The same image runs on three targets:

- **Docker** — `docker compose up --build`, single-stage `Dockerfile` on a digest-pinned
  `node:24-slim`, runs as a non-root user.
- **StartOS 0.3.5.1** — `manifest.yaml` + Deno embassy procedures under `scripts/`, packed with
  `start-sdk`.
- **StartOS 0.4.0** — the TypeScript SDK tree under `startos/`, packed with `start-cli`.

The `Makefile` wraps these: `make test-builds` produces both `.s9pk` files, and `make verify-0351` /
`make verify-040` validate them. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full build and test
workflow.
