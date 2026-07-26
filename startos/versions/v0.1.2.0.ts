import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_2_0 = VersionInfo.of({
  version: '0.1.2:0',
  releaseNotes: {
    en_US:
      'DuckDNS naming for raw-IP endpoints. MiningRigRentals does not refund rentals pointed at a bare IP address — so if your stratum endpoint is a raw IP (typically a self-hosted VPS tunnel), Pickhash can now give it a free, stable DNS name via DuckDNS and use that for all rentals, protecting your refunds. Enter a DuckDNS subdomain and token in first-run setup or on Settings → Stratum endpoint (the option appears only when your endpoint is a raw IP, and is on by default). Pickhash points the name at your endpoint, verifies it resolves before switching, and then keeps it in sync automatically if your VPS IP ever changes — no rentals need re-pointing. Your token is encrypted at rest and never leaves your server; if verification fails, your working raw-IP endpoint is kept so setup is never blocked. A HashGG playit tunnel already gives you a hostname, so this won\'t appear there.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
