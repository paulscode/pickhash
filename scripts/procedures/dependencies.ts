import { types as T } from "../deps.ts";

export const dependencies: T.ExpectedExports.dependencies = {
  hashgg: {
    // HashGG only needs to be installed and running for Pickhash to auto-discover
    // the public stratum endpoint. Pickhash imposes no config requirements on it.
    // deno-lint-ignore require-await
    async check(_effects, _configInput) {
      return { result: null };
    },
    // deno-lint-ignore require-await
    async autoConfigure(_effects, configInput) {
      return { result: configInput };
    },
  },
};
