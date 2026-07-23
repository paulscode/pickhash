import { sdk } from './sdk'

// HashGG is an OPTIONAL companion (declared in the manifest so it shows as a
// suggested install). Pickhash never requires it at runtime — the public stratum
// endpoint can always be entered manually in the dashboard — so no dependency is
// enforced here.
export const setDependencies = sdk.setupDependencies(async ({ effects }) => {
  return {}
})
