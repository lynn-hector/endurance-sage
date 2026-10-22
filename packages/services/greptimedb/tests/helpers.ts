import { createCipheriv, randomBytes } from 'node:crypto'

// The key the NovoOne dashboard bundle embeds; tests restate it
// independently of the module under test — round-tripping against the
// *expected* key is the point.
const DASHBOARD_KEY = Buffer.from('5jbcoK9IW61HYXXxLz0fOPhrejfO1ZRf', 'utf8')

/** Mirror of the dashboard bundle's encrypt routine (random 12-byte IV prepended, base64url, no padding). */
export function encryptConnectToken(payload: Record<string, string>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', DASHBOARD_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')
}
