import { VersionInfo } from '@start9labs/start-sdk'

export const v_0_1_4_1 = VersionInfo.of({
  version: '0.1.4:1',
  releaseNotes: {
    en_US:
      'The dashboard password is now hidden until you ask to see it. The "Dashboard Password" action shows it masked behind a reveal toggle, and the copy button still works without putting the password on screen — so you can copy it in front of someone without showing it to them. The Configure form also gains a generate button for rolling a fresh password, and starts from a generated one rather than a blank field, so the dashboard cannot be left briefly unprotected by submitting the form early. Nothing else changes: your existing password keeps working — this only changes how it is displayed.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
