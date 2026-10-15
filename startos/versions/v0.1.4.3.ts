import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_4_3 = VersionInfo.of({
  version: '0.1.4:3',
  releaseNotes: {
    en_US:
      'Rebuilt on version 3 of the StartOS packaging SDK, which needs StartOS ' +
      '0.4.0.2. Nothing you have set changes. ' +
      'Saving a pool endpoint now correctly detects whether it honours a ' +
      'difficulty request in the Stratum password. It used to report BLAKE2b ' +
      'gateways as unsupported, so rented BLAKE2b rigs were never given a ' +
      'difficulty suited to their size. An endpoint saved before this update ' +
      'keeps its old result until you save it again.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
