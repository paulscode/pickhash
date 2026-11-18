import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_8_1 = VersionInfo.of({
  version: '0.1.8:1',
  releaseNotes: {
    en_US:
      'The browser tab now shows where you are and what Pickhash is doing, for example "Dashboard · Autopilot · 2.25 PH/s · Pickhash", so you can see the state of a session without switching to the tab. From contributor theSeattleUnfreeze.',
  },
  migrations: {
    // Nothing to migrate: a frontend change only.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
