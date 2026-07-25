import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_1 = VersionInfo.of({
  version: '0.1.0:1',
  releaseNotes: {
    en_US:
      'Autopilot rig selection now picks the cheapest rigs that fit your target without over-provisioning, and the preview matches what it actually rents (fixing an estimate that could read ~6x high). New Ocean fallback pool (on by default): if your pool endpoint drops, rented hashrate fails over to Ocean — mining to your same Bitcoin address — instead of being wasted. Market tab: a new "hashrate you\'ve aimed at your own node" impact chart, a clearer pay-rate line that persists after a session, and an estimated rate in the Autopilot preview. Also: HashGG uptime now reads n/a when HashGG isn\'t configured.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
