import { configJson } from './fileModels/config.json'
import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info('Starting Pickhash...')

  // The dashboard password is managed on the Configure screen and seeded with a
  // random value on init; hand it to the container so login uses it from boot.
  const cfg = await configJson.read().const(effects)
  const dashboardPassword = cfg?.dashboardPassword || ''

  const mainSub = await sdk.SubContainer.of(
    effects,
    { imageId: 'main' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: '/root',
      readonly: false,
    }),
    'pickhash-sub',
  )

  return sdk.Daemons.of(effects)
    .addDaemon('pickhash', {
      subcontainer: mainSub,
      exec: {
        command: ['docker_entrypoint.sh'],
        env: {
          PORT: String(uiPort),
          DATA_DIR: '/root/data',
          // On StartOS 0.4.0 the HashGG service is reachable at this host name.
          // Setting it only ENABLES optional auto-discovery; if HashGG is not
          // installed the probe simply fails and Pickhash stays fully usable.
          HASHGG_HOST: 'hashgg.startos',
          HASHGG_PORT: '3000',
          DASHBOARD_PASSWORD: dashboardPassword,
          // The dashboard is reached over StartOS's encrypted transport, so mark the cookie Secure.
          COOKIE_SECURE: '1',
          // Where to find/change the password in this platform's UI (shown on the
          // login screen). 0.4.0: Actions → Configure. 0.3.5.1 sets its own path.
          DASHBOARD_PASSWORD_PATH:
            'Change it in the Pickhash service under Actions → Configure → Dashboard Password.',
        },
      },
      ready: {
        display: i18n('Pickhash Dashboard'),
        fn: () =>
          sdk.healthCheck.checkPortListening(effects, uiPort, {
            successMessage: i18n('The Pickhash dashboard is ready'),
            errorMessage: i18n('The Pickhash dashboard is not ready'),
          }),
      },
      requires: [],
    })
    .addHealthCheck('rental-api-reachable', {
      // Advisory only: a remote outage of the rental marketplace must never strand
      // the package, so this check reports reachability without ever failing.
      ready: {
        display: i18n('Rental API Reachable'),
        fn: async () => {
          try {
            await mainSub.exec([
              'curl',
              '-fsS',
              '-m',
              '8',
              '-o',
              '/dev/null',
              '-I',
              'https://www.miningrigrentals.com',
            ])
            return {
              result: 'success',
              message: i18n('The rental API host is reachable'),
            }
          } catch (e) {
            return {
              result: 'success',
              message: i18n(
                'The rental API host is not reachable (advisory — Pickhash remains available)',
              ),
            }
          }
        },
      },
      requires: ['pickhash'],
    })
})
