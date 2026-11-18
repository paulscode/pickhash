import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_8_0 = VersionInfo.of({
  version: '0.1.8:0',
  releaseNotes: {
    en_US:
      'Autopilot no longer fills a small leftover gap with the dearest rigs on the market (issue #15). Once the cheap rigs have covered most of your target, it may close the rest with a modestly larger rig, by up to your hashrate tolerance, and it stops once it is within that tolerance, as the live loop always has. ' +
      'The Autopilot preview now honours your rate ceiling, with the same per-rig backstop the live loop uses, and re-runs when you change it, so it shows what LIVE would rent. An untouched preview is held to the ceiling it suggests. When the ceiling is what leaves a shortfall, it says so. ' +
      'New: a ceiling feed (issue #16). In Settings, Guardrails, a Ceiling feed URL lets a program of yours set the price ceilings from what hashrate is worth right now. It is read every minute and fails closed: if it is unreachable, unreadable, or older than its max age, or if it sends 0, autopilot and auto-extend rent and extend nothing until it is good again. Running rentals are never cancelled, quick rents are not affected, and the feed can never go above a ceiling you set yourself. It must be https, or plain http on your own network. See docs/how-it-works.md for its format. ' +
      'Also new, from contributor Chris Guida: fill the stratum endpoint from a pool already saved on your MiningRigRentals account; a walkthrough for making a DuckDNS name, with a random one suggested; and, in DRY-RUN, a panel showing what autopilot would have rented. ' +
      "Changes to note: a ceiling of 0 now means rent nothing everywhere (it used to mean no ceiling in the preview and at session start), and an unreadable ceiling is refused rather than treated as none. A ceiling lowered below what a session already holds now stops new rentals above it; before, rigs cheaper than what was held could still be rented. Rigs over your per-rig backstop are now left out of autopilot's plan, and an alert names whichever ceiling is holding a session below target. A per-rig backstop of 0 or a tight one no longer stops a session from starting; it waits, and the alert says why. " +
      'Fixed: autopilot could plan a rig your per-rig backstop refuses, then stall on it every tick with no alert. Settings no longer waits on MiningRigRentals before showing your endpoint.',
  },
  migrations: {
    // Migration 014 is a database migration the app applies itself on start: an index on
    // decisions for the DRY-RUN rehearsal panel. Nothing to do here.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
