import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// User-facing settings stored on the main volume. main.ts reads these and passes
// them to the container as environment. The dashboard password lives here (not a
// hidden store) because it is the one secret the user is meant to see and change:
// it is surfaced on the Configure / Dashboard Password actions and seeded with a
// random value on first init when left blank.
export const configJson = FileHelper.json(
  {
    base: sdk.volumes.main,
    subpath: '/config.json',
  },
  z.object({
    dashboardPassword: z.string().catch(''),
  }),
)
