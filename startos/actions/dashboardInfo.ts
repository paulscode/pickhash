import { T } from '@start9labs/start-sdk'
import { configJson } from '../fileModels/config.json'
import { sdk } from '../sdk'

// Surfaces the dashboard login password so the user can copy it. The password is
// changed via the Configure action. Shown unmasked + copyable by design
// (copyability is the priority); treat it like a hot-wallet key.
export const dashboardInfo = sdk.Action.withoutInput(
  'dashboard-info',

  async ({ effects }) => ({
    name: 'Dashboard Password',
    description: 'Show the dashboard login password',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> => {
    const cfg = await configJson.read().once()
    return {
      version: '1' as const,
      title: 'Dashboard Password',
      message:
        'Use this password to log in to the Pickhash dashboard. Treat it like a hot-wallet key. Change it from the Configure action.',
      result: {
        type: 'single' as const,
        value: cfg?.dashboardPassword ?? '',
        copyable: true,
        qr: false,
        masked: false,
      },
    }
  },
)
