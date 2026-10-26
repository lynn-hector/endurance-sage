import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptConnectToken } from '../src/connect-token.ts'
import { encryptConnectToken } from './helpers.ts'

describe('decryptConnectToken', () => {
  it('round-trips a dashboard-shaped payload', () => {
    const token = encryptConnectToken({
      h: 'https://greptimedb.br.novoone.com',
      u: 'grafana',
      p: 's3cret',
      d: 'public',
    })
    expect(decryptConnectToken(token)).toEqual({
      h: 'https://greptimedb.br.novoone.com',
      u: 'grafana',
      p: 's3cret',
      d: 'public',
    })
  })

  it('tolerates surrounding whitespace', () => {
    const token = encryptConnectToken({ u: 'a', p: 'b' })
    expect(decryptConnectToken(`  ${token}\n`)).toEqual({ u: 'a', p: 'b' })
  })

  it('rejects a whole connect URL with a targeted hint', () => {
    const token = encryptConnectToken({ u: 'a', p: 'b' })
    expect(() => decryptConnectToken(`https://greptimedb.br.novoone.com/#/connect?token=${token}`))
      .toThrow('只填 token 本身')
  })

  it('rejects tokens shorter than iv+tag', () => {
    expect(() => decryptConnectToken('QUJDRA')).toThrow('长度不合法')
  })

  it('rejects tampered ciphertext (GCM auth failure)', () => {
    const token = encryptConnectToken({ u: 'a', p: 'b' })
    const flipped = token.slice(0, -6) + (token.endsWith('A') ? 'B'.repeat(6) : 'A'.repeat(6))
    expect(() => decryptConnectToken(flipped)).toThrow('解密失败')
  })

  it('rejects a token encrypted with a different key', () => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), iv)
    const ciphertext = Buffer.concat([cipher.update('{"u":"a"}', 'utf8'), cipher.final()])
    const token = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')
    expect(() => decryptConnectToken(token)).toThrow('解密失败')
  })
})
