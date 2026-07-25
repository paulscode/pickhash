import { VersionGraph } from '@start9labs/start-sdk'
import { v_0_1_0_0 } from './v0.1.0.0'
import { v_0_1_0_1 } from './v0.1.0.1'
import { v_0_1_0_2 } from './v0.1.0.2'

export const versionGraph = VersionGraph.of({
  current: v_0_1_0_2,
  other: [v_0_1_0_0, v_0_1_0_1],
})
