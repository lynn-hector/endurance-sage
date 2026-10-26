import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveCodeBaseDir } from '../src/index.ts'

let dir: string
let storeHome: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-matrix-code-'))
  storeHome = join(dir, 'store-home')
  mkdirSync(storeHome)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Point DSH_HOME at the tmp store home and write the given store content. */
function stubStore(text: string): void {
  vi.stubEnv('DSH_HOME', storeHome)
  writeFileSync(join(storeHome, '.credentials.yaml'), text)
}

describe('resolveCodeBaseDir', () => {
  it('returns undefined when no source configures it', () => {
    stubStore('version: 1\nrefs: {}\n')
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '')
    expect(resolveCodeBaseDir()).toBeUndefined()
  })

  it('reads DSH_SENTRY_CODE_BASE from the credential store refs layer', () => {
    stubStore([
      'version: 1',
      'refs:',
      '  DSH_SENTRY_CODE_BASE: /store/novo-commctl',
      'records: []',
    ].join('\n'))
    expect(resolveCodeBaseDir()).toBe('/store/novo-commctl')
  })

  it('reads DSH_SENTRY_CODE_BASE from a flat hand-written store', () => {
    stubStore('DSH_SENTRY_CODE_BASE: /flat/novo-commctl\n')
    expect(resolveCodeBaseDir()).toBe('/flat/novo-commctl')
  })

  it('environment variable wins over the credential store', () => {
    stubStore('refs:\n  DSH_SENTRY_CODE_BASE: /store/x\n')
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/env/novo-commctl')
    expect(resolveCodeBaseDir()).toBe('/env/novo-commctl')
  })

  it('envs.yml codeRepository.baseDir wins over store and environment', () => {
    stubStore('refs:\n  DSH_SENTRY_CODE_BASE: /store/x\n')
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/env/x')
    expect(resolveCodeBaseDir({ codeRepository: { baseDir: '/matrix/novo-commctl' } }))
      .toBe('/matrix/novo-commctl')
  })

  it('missing store file leaves the value to the other sources', () => {
    vi.stubEnv('DSH_HOME', join(dir, 'no-such-home'))
    expect(resolveCodeBaseDir()).toBeUndefined()
  })

  it('expands a leading ~ to the home dir — stored/env values never pass through a shell', () => {
    stubStore('refs:\n  DSH_SENTRY_CODE_BASE: ~/novoone-backend\n')
    expect(resolveCodeBaseDir()).toBe(join(homedir(), 'novoone-backend'))
  })

  it('expands a bare ~ to the home dir', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '~')
    expect(resolveCodeBaseDir()).toBe(homedir())
  })

  it('leaves paths without a leading ~ untouched (relative or with ~ mid-path)', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', './rel/code')
    expect(resolveCodeBaseDir()).toBe('./rel/code')
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/srv/~weird')
    expect(resolveCodeBaseDir()).toBe('/srv/~weird')
  })
})
