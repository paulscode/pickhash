import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_4_3 = VersionInfo.of({
  version: '0.1.4:3',
  releaseNotes: {
    en_US:
      'Rebuilt on version 3 of the StartOS packaging SDK, which needs StartOS ' +
      '0.4.0.2. Nothing you have set changes.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
