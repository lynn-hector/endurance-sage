import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { knownCredentialKeys } from '../src/index.ts'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-matrix-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('knownCredentialKeys', () => {
  it('reads hand-written flat stores (credential keys at the top level)', () => {
    const path = join(dir, 'flat.yaml')
    writeFileSync(path, 'GREPTIMEDB_DP0_USERNAME: user\nZADIG_API_TOKEN: token\n')
    expect(knownCredentialKeys(path, {})).toEqual(new Set(['GREPTIMEDB_DP0_USERNAME', 'ZADIG_API_TOKEN']))
  })

  it('reads dsh-managed stores with keys nested under refs (version/refs/records)', () => {
    const path = join(dir, 'nested.yaml')
    writeFileSync(path, [
      'version: 1',
      'refs:',
      '  GREPTIMEDB_DP0_USERNAME: user',
      '  GREPTIMEDB_DP0_PASSWORD: secret',
      '  ZADIG_API_TOKEN: token',
      'records: []',
    ].join('\n'))
    const keys = knownCredentialKeys(path, {})
    for (const key of ['GREPTIMEDB_DP0_USERNAME', 'GREPTIMEDB_DP0_PASSWORD', 'ZADIG_API_TOKEN']) {
      expect(keys.has(key), key).toBe(true)
    }
  })

  it('treats the process environment as always known, with or without a store file', () => {
    const keys = knownCredentialKeys(join(dir, 'missing.yaml'), { ZADIG_API_TOKEN: 'token' })
    expect(keys.has('ZADIG_API_TOKEN')).toBe(true)
  })

  it('survives an empty or malformed store file', () => {
    const path = join(dir, 'empty.yaml')
    writeFileSync(path, '')
    expect(knownCredentialKeys(path, {}).size).toBe(0)
  })
})
