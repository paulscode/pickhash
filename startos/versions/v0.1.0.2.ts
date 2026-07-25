import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_0_2 = VersionInfo.of({
  version: '0.1.0:2',
  releaseNotes: {
    en_US:
      'Fixes the Ocean fallback pool for Autopilot: the safety net is now actually attached to Autopilot rentals (previously only manual rents got it, so most rented hashrate had no failover if your endpoint dropped). New blended rate ceiling: cap your overall pay-rate — the "you" line on the market chart — from the Autopilot preview or Settings, in sats/PH·day. Autopilot fills your target with the cheapest rigs while holding the average under your cap, leaving a shortfall rather than overpaying when the market runs hot, with a per-rig backstop so no single rig is absurdly priced. Auto-extend now respects the ceiling too, the preview keeps a ceiling you\'ve typed, and shortfall reporting is more accurate.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
