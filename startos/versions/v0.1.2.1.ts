import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_2_1 = VersionInfo.of({
  version: '0.1.2:1',
  releaseNotes: {
    en_US:
      "The Ocean fallback pool now connects to Ocean's BIP110 stratum endpoint (bip110.mine.ocean.xyz:3110) instead of the general one, so hashrate that fails over is mining the block templates you'd want it on. Everything else about the fallback is unchanged: it only engages if your own endpoint drops (or when a stuck rig is rerouted), it mines to your same Bitcoin address, and its worker is still tagged .fallback so fallback hashrate is easy to spot on Ocean. Existing rentals keep whatever fallback they were created with; new rentals get the new endpoint.",
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
