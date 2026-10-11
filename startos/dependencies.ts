import { sdk } from './sdk'
import { hashggDescription } from './manifest/i18n'

// HashGG is an OPTIONAL companion, listed in the manifest so it shows as a
// suggested install. Pickhash never requires it at runtime (the public stratum
// endpoint can always be entered manually in the dashboard), so the dependency
// is never enabled and no requirement is published.
const hashgg = sdk.Dependency.optional('hashgg', {
  description: hashggDescription,
  metadata: {
    title: 'HashGG',
    icon: 'https://raw.githubusercontent.com/paulscode/hashgg/master/icon.png',
  },
  kind: 'exists',
  versionRange: '*',
  enabled: async () => false,
})

export const dependencies = sdk.Dependencies.of().addDependency(hashgg)
