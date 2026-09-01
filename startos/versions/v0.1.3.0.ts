import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_3_0 = VersionInfo.of({
  version: '0.1.3:0',
  releaseNotes: {
    en_US:
      'Adds BLAKE2b. Pickhash can now rent either SHA256 AsicBoost or Blake2B Siacoin hashrate, chosen in Settings, so it works against a BLAKE2b node as well as a Bitcoin one.\n\nThe two markets are kept apart. Prices, available hashrate, spend ceilings, your saved endpoint and the display unit are all per algorithm, because a TH of BLAKE2b costs roughly 2,425 times a TH of SHA256 on a market around 269,000 times smaller. A limit set for one means nothing for the other, so nothing is shared and nothing is mixed into one chart or one total.\n\nWhich algorithm is active is shown in the header on every screen, and again on both screens that spend, so a rental cannot be confirmed without it being visible.\n\nTwo things that would have quietly cost money on BLAKE2b are fixed. The protective per-rig price cap sent to MiningRigRentals was always expressed per PH, which on a market quoted per TH would have been a thousand times higher than intended. The Ocean fallback pool is SHA256 only and defaulted to on; it is now unavailable on BLAKE2b instead of failing hashrate over to a pool that cannot mine it.\n\nIf you use HashGG, Pickhash reads the endpoint from either HashGG or HashGG Companion, and picks per algorithm.\n\nExisting installs are unaffected. Everything already recorded is labelled SHA256 AsicBoost, which is what it was.',
  },
  migrations: {
    // Nothing to do here. The algorithm dimension is a database migration the app
    // applies itself on start (009 and 010), which is where every other schema change
    // for this app lives; StartOS migrations only handle things outside the database.
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
