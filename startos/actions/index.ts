import { sdk } from '../sdk'
import { config } from './config'
import { dashboardInfo } from './dashboardInfo'

export const actions = sdk.Actions.of()
  .addAction(config)
  .addAction(dashboardInfo)
