/**
 * Connect-token support for the NovoOne GreptimeDB dashboard.
 *
 * The dashboard ships a `/#/token-generator` page that wraps credentials
 * into a shareable `#/connect?token=…` URL: the token is
 * `base64url(iv(12) || AES-256-GCM(key, iv, JSON {h,u,p,d}))` with the raw
 * key embedded in the dashboard bundle — public by construction, since the
 * browser decrypts it too. The wire protocol stays HTTP Basic; this module
 * only turns a bare token back into the username/password pair.
 *
 * @module @dsh-sentry/service-greptimedb
 */

import { createDecipheriv } from 'node:crypto'

/**
 * Raw 32-byte AES-256-GCM key embedded in the NovoOne dashboard bundle
 * (extracted 2026-10-21 from the greptimedb.br.novoone.com JS). If the
 * dashboard rotates it, decryption fails with a clear error and this
 * constant must be refreshed from the new bundle.
 */
const CONNECT_TOKEN_KEY = Buffer.from('5jbcoK9IW61HYXXxLz0fOPhrejfO1ZRf', 'utf8')

/** Payload the dashboard encrypts: host / username / password / database. */
export interface ConnectTokenPayload {
  h?: string
  u?: string
  p?: string
  d?: string
}

/** Decrypt a bare connect token — NOT the whole `#/connect?token=…` URL. */
export function decryptConnectToken(token: string): ConnectTokenPayload {
  if (/^https?:\/\//i.test(token) || token.includes('#/connect')) {
    throw new Error('connect token 应只填 token 本身（#/connect?token= 后面的部分），不是整条 URL')
  }
  const normalized = token.trim().replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(normalized, 'base64')
  if (buf.length <= 12 + 16) {
    throw new Error('connect token 长度不合法（短于 iv+tag 最小长度），请检查是否完整复制')
  }
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const ciphertext = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', CONNECT_TOKEN_KEY, iv)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (cause) {
    throw new Error(`connect token 解密失败（token 无效或 dashboard 密钥已轮换）: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  try {
    return JSON.parse(plain.toString('utf8')) as ConnectTokenPayload
  } catch {
    throw new Error('connect token 明文不是合法 JSON，token 无效')
  }
}
