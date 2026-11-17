import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_7_0 = VersionInfo.of({
  version: '0.1.7:0',
  releaseNotes: {
    en_US:
      'Pickhash now checks whether your Datum Gateway can give each rented rig its own difficulty, and warns you when it cannot. ' +
      'A pool such as CONVOY sizes its minimum share difficulty to your gateway’s total hashrate, and a stock Datum Gateway pushes every miner up to it. Behind a busy gateway each rented rig is then asked for a difficulty sized for your whole fleet: it finds a share only every few minutes, MiningRigRentals shows the rig owner a "High Worker Difficulty" warning and reads its delivery as choppy (the under-delivery notices), and the rig reconnects every couple of minutes. ' +
      'The new Datum Gateway (SHA256) and Datum Gateway (BLAKE2b) in the PaulsCode registry, and the updated Datum Gateway Companions, fix this: each rig keeps a difficulty that suits it while the work stays committed at the pool’s minimum, so pool credit is unchanged. Tested live on CONVOY. ' +
      'The endpoint test in Setup and Settings reports what your gateway supports, and a standing alert names the app to install from the PaulsCode registry until it is updated (or tells you to switch the setting on). It clears by itself once the gateway is updated. ' +
      'Also fixed: a stratum endpoint that answered the endpoint test or the periodic health check with something other than a JSON object (for example the word null) could crash Pickhash; such replies are now ignored.',
  },
  migrations: {
    // Migration 013 is a database migration the app applies itself on start: it adds the
    // column recording what the endpoint's Datum Gateway supports. Nothing to do here.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
