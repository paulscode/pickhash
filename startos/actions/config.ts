import { configJson } from '../fileModels/config.json'
import { sdk } from '../sdk'

const { InputSpec, Value } = sdk

export const inputSpec = InputSpec.of({
  dashboardPassword: Value.text({
    name: 'Dashboard Password',
    description:
      'The password to log in to the Pickhash dashboard. Use "Dashboard Password" under Actions to copy it, or set your own here. Treat it like a hot-wallet key — it protects controls that spend Bitcoin.',
    required: true,
    // Generated rather than blank, so the dashboard is never briefly unprotected if this is
    // submitted before init has seeded one.
    default: { charset: 'a-z,A-Z,0-9', len: 24 },
    masked: true,
    generate: { charset: 'a-z,A-Z,0-9', len: 24 },
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
