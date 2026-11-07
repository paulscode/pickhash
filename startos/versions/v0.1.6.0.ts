import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_6_0 = VersionInfo.of({
  version: '0.1.6:0',
  releaseNotes: {
    en_US:
      'You can now change your payout address in the middle of a session without stopping it. ' +
      'To do it: (1) In Pickhash, open Settings, Stratum endpoint, keep the host and port, enter the new address in the worker field and click Test & save endpoint. In LIVE mode every running rental moves to the new address within about a minute, and an alert confirms it; each rig reconnects once. ' +
      '(2) In Datum Gateway, set the same payout address and restart the gateway when convenient, ideally between sessions. Datum pays its own address for any block it mines solo while the pool is unreachable, so it should match. ' +
      'Keep the old wallet: shares already credited to it go on being paid for a while. The full guide is docs/changing-payout-address.md in the Pickhash repository. ' +
      'A payout address with a typo is now refused when you save it. Datum Gateway does not check usernames, so a mistyped address used to pass the endpoint test and get credited with everything the rentals mined. ' +
      'Saving a new stratum host or port also moves running rentals to it; before, they stayed on the old tunnel until they ended. Pickhash keeps the pool saved in your MiningRigRentals account in step with the endpoint, including after an automatic tunnel repair or a DuckDNS change. ' +
      'Updating or restarting Pickhash during a session is safer: it now waits for a rental purchase or extension already in progress to be recorded before it stops, rather than possibly losing track of one it had paid for.',
  },
  migrations: {
    // Migration 012 is a database migration the app applies itself on start: it adds the
    // host each rental points at and fills it in for running rentals. Nothing to do here.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
