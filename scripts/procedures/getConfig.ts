import { compat, types as T } from "../deps.ts";

// User-facing config. The dashboard password is read by docker_entrypoint.sh from
// start9/config.yaml and passed to the app as DASHBOARD_PASSWORD. It is seeded with
// a random 32-char value on install so the dashboard is protected from first boot.
export const getConfig: T.ExpectedExports.getConfig = compat.getConfig({
  "dashboard-password": {
    "type": "string",
    "name": "Dashboard Password",
    "description":
      "The password to log in to the Pickhash dashboard. Copy it to log in, or change it here. Treat it like a hot-wallet key — it protects controls that spend Bitcoin.",
    "nullable": false,
    "masked": true,
    "default": { "charset": "a-z,A-Z,0-9", "len": 32 },
  },
});
