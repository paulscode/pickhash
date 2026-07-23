import { setupManifest } from '@start9labs/start-sdk'
import { short, long, hashggDescription } from './i18n'

export const manifest = setupManifest({
  id: 'pickhash',
  title: 'Pickhash',
  license: 'mit',
  packageRepo: 'https://github.com/paulscode/pickhash',
  upstreamRepo: 'https://github.com/paulscode/pickhash',
  marketingUrl: 'https://github.com/paulscode/pickhash',
  donationUrl: null,
  docsUrls: [],
  description: { short, long },
  volumes: ['main'],
  images: {
    main: {
      source: {
        dockerBuild: {
          dockerfile: 'Dockerfile',
          workdir: '.',
        },
      },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: {
    install: null,
    update: null,
    uninstall: null,
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {
    hashgg: {
      description: hashggDescription,
      optional: true,
      metadata: {
        title: 'HashGG',
        icon: 'https://raw.githubusercontent.com/paulscode/hashgg/master/icon.png',
      },
    },
  },
})
