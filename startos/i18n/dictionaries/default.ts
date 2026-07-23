export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Pickhash Dashboard': 0,
  'The Pickhash dashboard is ready': 1,
  'The Pickhash dashboard is not ready': 2,
  'Rental API Reachable': 3,
  'The rental API host is reachable': 4,
  'The rental API host is not reachable (advisory — Pickhash remains available)': 5,

  // interfaces.ts
  'Web UI': 10,
  'The Pickhash dashboard for renting Bitcoin hashrate on your own terms': 11,
} as const

export type LangDict = { [K in (typeof dict)[keyof typeof dict]]?: string }

export default dict
