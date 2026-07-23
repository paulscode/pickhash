import { configJson } from '../fileModels/config.json'
import { urlsafe } from '../secrets'
import { sdk } from '../sdk'

// Runs once on install (and on every version migration). Seeds a random dashboard
// password when the user hasn't set one, so the app is protected from first boot
// without the user having to invent a password.
export const seedFiles = sdk.setupOnInit(async (effects) => {
  const cfg = await configJson.read().once()
  await configJson.merge(effects, {
    dashboardPassword: cfg?.dashboardPassword || urlsafe(32),
  })
})
