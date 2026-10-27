import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeRepositoryService from '../src/index.ts'

/**
 * Constructor baseDir fallback: when Config omits every discovery source
 * (repos/baseDir/repoPath), the machine-local chain (env var > credential
 * store DSH_SENTRY_CODE_BASE) resolves at construction time so personal
 * paths stay off the tracked assemblies. Any explicit discovery source
 * disables the fallback — the glob must never shadow repos/repoPath.
 */

let dir: string
let storeHome: string
let base: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-code-fallback-'))
  storeHome = join(dir, 'store-home')
  base = join(dir, 'code-base')
  mkdirSync(storeHome)
  mkdirSync(join(base, 'novo-commctl-config'), { recursive: true })
  mkdirSync(join(base, 'unrelated'), { recursive: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

afterEach(() => vi.unstubAllEnvs())

/** Point DSH_HOME at the tmp store home, remove the env var, write the store. */
function stubStore(text: string): void {
  vi.stubEnv('DSH_HOME', storeHome)
  // undefined 删除该键；空字符串也应继续回退到凭据库层
  vi.stubEnv('DSH_SENTRY_CODE_BASE', undefined)
  writeFileSync(join(storeHome, '.credentials.yaml'), text)
}

describe('CodeRepositoryService baseDir fallback', () => {
  it('falls back to the credential-store chain when Config omits every discovery source', () => {
    stubStore(`refs:\n  DSH_SENTRY_CODE_BASE: ${base}\n`)
    const service = new CodeRepositoryService(new Context(), {})
    expect(service.discoverRepos().map((repo) => repo.name)).toEqual(['novo-commctl-config'])
  })

  it('explicit baseDir Config wins — no machine-layer lookup', () => {
    stubStore(`refs:\n  DSH_SENTRY_CODE_BASE: ${base}\n`)
    const other = join(dir, 'other-base')
    mkdirSync(join(other, 'novo-other'), { recursive: true })
    const service = new CodeRepositoryService(new Context(), { baseDir: other })
    expect(service.discoverRepos().map((repo) => repo.name)).toEqual(['novo-other'])
  })

  it('a configured repos map disables the fallback (glob must not shadow it)', () => {
    stubStore(`refs:\n  DSH_SENTRY_CODE_BASE: ${base}\n`)
    const single = join(dir, 'single-repo')
    mkdirSync(single)
    const service = new CodeRepositoryService(new Context(), { repos: { pinned: single } })
    expect(service.discoverRepos().map((repo) => repo.name)).toEqual(['pinned'])
  })

  it('a configured repoPath disables the fallback (glob must not shadow it)', () => {
    stubStore(`refs:\n  DSH_SENTRY_CODE_BASE: ${base}\n`)
    const single = join(dir, 'single-repo')
    const service = new CodeRepositoryService(new Context(), { repoPath: single })
    expect(service.discoverRepos().map((repo) => repo.name)).toEqual(['single-repo'])
  })

  it('unresolvable fallback leaves the leg unconfigured (no hardcoded default)', () => {
    stubStore('refs: {}\n')
    const service = new CodeRepositoryService(new Context(), {})
    expect(service.discoverRepos()).toEqual([])
  })
})
