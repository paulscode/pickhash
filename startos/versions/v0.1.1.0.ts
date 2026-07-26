import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_1_0 = VersionInfo.of({
  version: '0.1.1:0',
  releaseNotes: {
    en_US:
      'Autopilot reliability release. Dead-rig fallback: when a rented rig connects but never mines on your pool while your other rigs are mining fine, Autopilot now reroutes just that one rig to the Ocean fallback and messages its owner, so its paid time isn\'t wasted (on by default, alongside the Ocean fallback). Self-healing rig scoring: a rig that delivered nothing is never rented again, and consistently reliable rigs earn a ranking preference. The Autopilot preview\'s suggested rate ceiling now carries headroom so it fills your target instead of stalling just under the cap, with a new alert when it\'s holding below target because the ceiling was reached. Fixes: a session now ends cleanly when its budget can no longer rent anything or the ceiling blocks every rental — no more showing "running" with no live rigs — and the preview\'s budget-runway estimate is now accurate and monotonic.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
