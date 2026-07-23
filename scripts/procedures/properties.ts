import { types as T } from "../deps.ts";

// Pickhash keeps all of its configuration and status inside the dashboard (open
// the Web UI). StartOS "Properties" therefore only points there — there are no
// server-side config values to surface here.
export const properties: T.ExpectedExports.properties = async (_effects) => {
  const data: T.PackagePropertiesV2 = {
    "Dashboard": {
      type: "string",
      value:
        "Open the Pickhash Web UI to set your target hashrate, budget, and marketplace credentials, and to monitor rentals.",
      description: "Where to configure and monitor Pickhash",
      copyable: false,
      masked: false,
      qr: false,
    },
  };
  return { result: { version: 2 as const, data } };
};
