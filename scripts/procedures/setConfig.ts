import { compat, types as T } from "../deps.ts";

// No config-driven dependencies: HashGG is an opt-in companion declared statically
// in the manifest, so a plain setConfig is all that's needed.
export const setConfig: T.ExpectedExports.setConfig = compat.setConfig;
