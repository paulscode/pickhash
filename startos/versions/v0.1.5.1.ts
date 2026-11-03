import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_5_1 = VersionInfo.of({
  version: '0.1.5:1',
  releaseNotes: {
    en_US:
      'Settings now save. Changing a value on the Settings page and clicking Save showed "Saved ✓", but the old value was what got stored, so it came back as soon as the page reloaded. This affected every setting on that page, including the spend guardrails (max session budget, max daily spend, blended rate ceiling and per-rig backstop), on both SHA256 and BLAKE2b. If you set guardrails there before, check them after updating and save them again: until now Pickhash has been using the defaults. ' +
      'A blended rate ceiling you change in Settings now also stays when you start Autopilot, instead of being replaced by a fresh suggestion. ' +
      'Clearing a number that cannot be left empty, such as a budget, now asks for a number instead of saving 0; clearing an optional ceiling turns it off. ' +
      'Changes made elsewhere were not affected: the endpoint, the API keys, the algorithm and the ceiling set from the Autopilot preview all saved as before.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
