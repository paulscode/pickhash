import { randomBytes } from 'crypto'

// URL-safe random token for the seeded dashboard password. 32 bytes -> 43
// url-safe chars, well above any minimum and safe to copy/paste.
export const urlsafe = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url')
