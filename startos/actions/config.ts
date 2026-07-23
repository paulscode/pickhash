import { configJson } from '../fileModels/config.json'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

export const inputSpec = InputSpec.of({
  dashboardPassword: Value.text({
    name: 'Dashboard Password',
    description:
      'The password to log in to the Pickhash dashboard. Copy it to log in, or change it here. Treat it like a hot-wallet key — it protects controls that spend Bitcoin.',
    required: true,
    default: null,
    masked: true,
  }),
})

export const config = sdk.Action.withInput(
  'config',

  async ({ effects }) => ({
    name: 'Configure',
    description: 'Configure Pickhash',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  // Pre-fill with the current config (the dashboard password was seeded on init).
  async ({ effects }) => configJson.read().once(),

  async ({ effects, input }) => configJson.merge(effects, input),
)
