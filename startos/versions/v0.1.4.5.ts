import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_4_5 = VersionInfo.of({
  version: '0.1.4:5',
  releaseNotes: {
    en_US:
      'Moves to Node.js 24.22.1, which fixes security flaws in TLS ' +
      'hostname checks and Brotli decompression. ' +
      'The image carries current CA certificates. ' +
      'Uses version 3.1.0 of the packaging SDK.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
