import { VersionGraph } from '@start9labs/start-sdk'
import { v_0_1_0_0 } from './v0.1.0.0'
import { v_0_1_0_1 } from './v0.1.0.1'
import { v_0_1_0_2 } from './v0.1.0.2'
import { v_0_1_1_0 } from './v0.1.1.0'
import { v_0_1_2_0 } from './v0.1.2.0'
import { v_0_1_2_1 } from './v0.1.2.1'
import { v_0_1_3_0 } from './v0.1.3.0'
import { v_0_1_4_0 } from './v0.1.4.0'
import { v_0_1_4_1 } from './v0.1.4.1'

export const versionGraph = VersionGraph.of({
  current: v_0_1_4_1,
  other: [v_0_1_0_0, v_0_1_0_1, v_0_1_0_2, v_0_1_1_0, v_0_1_2_0, v_0_1_2_1, v_0_1_3_0, v_0_1_4_0],
})
