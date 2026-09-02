import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { liveAssemblyEnv, liveAssemblyEntryConfig, type AssemblyPaths } from '../src/index.ts'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-matrix-live-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Assembly paths in the tmp dir; each call resets both files, writing only the given ones. */
function paths(includeText?: string, patchText?: string): AssemblyPaths {
  const include = join(dir, 'cordis.include.yml')
  const patch = join(dir, 'cordis.patch.yml')
  rmSync(include, { force: true })
  rmSync(patch, { force: true })
  if (includeText !== undefined) writeFileSync(include, includeText)
  if (patchText !== undefined) writeFileSync(patch, patchText)
  return { include, patch }
}

const INCLUDE_TP1 = [
  '# dsh-sentry 组装（env: tst-platform-hosted-1，include 格式）——由 apps/agent/envs.yml 生成，勿手改。',
  '  - id: sentry-tool-trace-analyzer',
  "    name: '@dsh-sentry/tool-trace-analyzer'",
  '    config:',
  '      env: tst-platform-hosted-1',
  '      greptimedbJaegerDatasourceUid: PCD48328C06B18945',
].join('\n')

const PATCH_DP0 = [
  '# dsh-sentry 组装（env: dev-platform-hosted-0）——由 apps/agent/envs.yml 生成，勿手改。',
  '',
  '- insert:',
  '    - id: sentry-tool-trace-analyzer',
  "      name: '@dsh-sentry/tool-trace-analyzer'",
  '      config:',
  '        env: dev-platform-hosted-0',
  '        greptimedbJaegerDatasourceUid: GreptimeDB-Jaeger',
  '    - id: sentry-tool-log-analyzer',
  "      name: '@dsh-sentry/tool-log-analyzer'",
  '      config:',
  '        env: dev-platform-hosted-0',
].join('\n')

describe('liveAssemblyEnv', () => {
  it('reads the env from the include file when present', () => {
    expect(liveAssemblyEnv(paths(INCLUDE_TP1, PATCH_DP0))).toBe('tst-platform-hosted-1')
  })

  it('falls back to the patch file when the include file is absent', () => {
    expect(liveAssemblyEnv(paths(undefined, PATCH_DP0))).toBe('dev-platform-hosted-0')
  })

  it('returns undefined when neither assembly file exists', () => {
    expect(liveAssemblyEnv(paths())).toBeUndefined()
  })

  it('returns undefined for files without a recognizable header', () => {
    expect(liveAssemblyEnv(paths('# some other file\n[]\n', undefined))).toBeUndefined()
  })
})

describe('liveAssemblyEntryConfig', () => {
  it('finds an entry config in the bare-list include format', () => {
    const config = liveAssemblyEntryConfig('sentry-tool-trace-analyzer', paths(INCLUDE_TP1, undefined))
    expect(config).toMatchObject({
      env: 'tst-platform-hosted-1',
      greptimedbJaegerDatasourceUid: 'PCD48328C06B18945',
    })
  })

  it('flattens the - insert: patch format and finds entries', () => {
    const config = liveAssemblyEntryConfig('sentry-tool-log-analyzer', paths(undefined, PATCH_DP0))
    expect(config).toMatchObject({ env: 'dev-platform-hosted-0' })
  })

  it('returns undefined for an unknown entry id', () => {
    expect(liveAssemblyEntryConfig('sentry-unknown', paths(INCLUDE_TP1, undefined))).toBeUndefined()
  })

  it('returns undefined when no assembly file exists', () => {
    expect(liveAssemblyEntryConfig('sentry-tool-trace-analyzer', paths())).toBeUndefined()
  })

  it('survives an unparsable include file by falling through to the patch file', () => {
    const config = liveAssemblyEntryConfig(
      'sentry-tool-trace-analyzer',
      paths('::: not yaml [', PATCH_DP0),
    )
    expect(config).toMatchObject({ greptimedbJaegerDatasourceUid: 'GreptimeDB-Jaeger' })
  })
})
