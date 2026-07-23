# Contributing to Pickhash

Thanks for your interest in improving Pickhash. It's MIT-licensed and meant to be evolved by a
community. This guide covers the development setup, how to run and write tests, the conventions the
codebase holds to, and how to build the installable packages.

Before diving in, [docs/architecture.md](docs/architecture.md) explains how the system fits together.

## Prerequisites

- **Node.js 24 or newer.** The backend uses the built-in `node:sqlite` module, which does not exist in
  older Node versions. If your machine has an older Node, the easiest path is to run everything in the
  official `node:24-slim` container (commands below).
- **Docker** — for running the app locally and (importantly) for running the test suite if your local
  Node is older than 24.
- For building the StartOS packages: `start-cli` (0.4.0), `start-sdk` (0.3.5.1), `deno`, `yq`, `jq`.
  These are only needed if you're working on the packaging.

Runtime has **zero npm dependencies**. The few `devDependencies` exist only for building the StartOS
0.4.0 TypeScript bundle and type-checking; the app itself never loads them.

## Running locally

```sh
docker compose up --build
```

Then open <http://localhost:3030> and follow the setup wizard. The app starts in **DRY-RUN**, so it
won't spend anything until you set a password and deliberately switch to LIVE.

## Running the tests

The suite uses the Node built-in test runner and must run on Node 24. The reliable, host-independent
way:

```sh
docker run --rm -v "$PWD":/app -w /app node:24-slim npm test
```

If your local Node is already 24+, `npm test` works directly. The test script is:

```
node --disable-warning=ExperimentalWarning --test 'app/backend/test/**/*.test.js'
```

Coverage (optional):

```sh
docker run --rm -v "$PWD":/app -w /app node:24-slim \
  node --test --experimental-test-coverage 'app/backend/test/**/*.test.js'
```

Please keep the suite green and add tests with any behavior change. Tests must be **deterministic** —
no dependence on real DNS, wall-clock timing, network, or live marketplace responses. When a test
needs an IP or a hostname, use documentation ranges (`198.51.100.0/24`, `203.0.113.0/24`) and the
`.gg`/`.example` test hosts already used in the suite; marketplace interactions are driven by fixtures
under `app/backend/test/fixtures/`, which contain **no real data**.

## Code conventions

- **Zero runtime dependencies.** Backend code imports only the Node standard library. Do not add a
  runtime dependency; if you think you need one, open an issue to discuss it first.
- **CommonJS** in the backend (`require`/`module.exports`).
- **Fail safe around money.** Anything that can spend must pass through the gate stage, default to a
  no-op in DRY-RUN, and never retry an operation with an ambiguous outcome.
- **Never log secrets.** Marketplace keys/secrets and the encryption key stay out of logs and error
  messages. Use parameterized SQL — never string-concatenate values into queries.
- **Frontend runs under a strict CSP.** With the Alpine.js CSP build, directives may use only bare
  property access, method calls, and the unary `!` — no operators, ternaries, or template literals in
  markup. Put real logic in `app/frontend/app.js` or compute it server-side. Render any untrusted
  string with `x-text` (never `x-html` or interpolation), and never place `<template x-for>` inside an
  `<svg>` (build chart geometry server-side).
- **After adding Tailwind classes, run `make css`** to regenerate the committed
  `app/frontend/dashboard.min.css` — the dev mount serves the on-disk file, so new classes are
  silently missing until you rebuild it.
- Match the style, naming, and comment density of the surrounding code.

## Building the packages

The `Makefile` wraps the build tooling:

| Target | What it does |
| --- | --- |
| `make css` | Rebuild the committed Tailwind CSS bundle. |
| `make icons` | Regenerate package icons from the master asset. |
| `make pack-0351` | Build the StartOS 0.3.5.1 `.s9pk`. |
| `make pack-040` | Build the StartOS 0.4.0 `.s9pk`. |
| `make test-builds` | Build both `.s9pk` packages. |
| `make verify-0351` / `make verify-040` | Validate the built packages. |
| `make clean-builds` | Remove build artifacts. |

## Submitting changes

1. Branch off `main`.
2. Make your change with matching tests; run the suite on Node 24 and confirm it's green.
3. If you touched the frontend, run `make css`.
4. Keep commits focused and messages descriptive.
5. Open a pull request describing the change and how you tested it.

Please **don't** include real credentials, real marketplace captures, or personal data in commits,
fixtures, or examples.

## Reporting security issues

Do **not** open a public issue for a security vulnerability. Follow the private process in
[SECURITY.md](SECURITY.md).
