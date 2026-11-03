import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_5_0 = VersionInfo.of({
  version: '0.1.5:0',
  releaseNotes: {
    en_US:
      'Autopilot no longer pays far over the market to fill a target. With few rigs listed, it used to fill the last gap with whatever was left, at many times the going rate. It now skips any rig priced more than double the market rate (the lower of the recent last-10 price and the median listed price). You can change the margin with "Max price over market" in Settings. The estimate shows the limit in use, and a new warning alert tells you when the limit is what keeps autopilot below target. ' +
      'A new converter in the header translates between SHA256 sats, BLAKE2b sats and the fiat currency of your choice. BTCB2 is priced from Neoxa, and BTC from CoinGecko with mempool.space as a fallback. Rates refresh every minute while the converter is open, and it says plainly when a source is unavailable. ' +
      'The rate-ceiling alert no longer clears and re-fires when the marketplace cannot be reached for a tick.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
