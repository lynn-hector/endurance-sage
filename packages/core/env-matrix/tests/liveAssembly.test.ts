import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assemblyAnchorEnv, extractCurrentEnv, type AssemblyPaths } from '../src/index.ts'

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

describe('assemblyAnchorEnv', () => {
  it('reads the env from the include file when present', () => {
    expect(assemblyAnchorEnv(paths(INCLUDE_TP1, PATCH_DP0))).toBe('tst-platform-hosted-1')
  })

  it('falls back to the patch file when the include file is absent', () => {
    expect(assemblyAnchorEnv(paths(undefined, PATCH_DP0))).toBe('dev-platform-hosted-0')
  })

  it('returns undefined when neither assembly file exists', () => {
    expect(assemblyAnchorEnv(paths())).toBeUndefined()
  })

  it('returns undefined for files without a recognizable header', () => {
    expect(assemblyAnchorEnv(paths('# some other file\n[]\n', undefined))).toBeUndefined()
  })
})

describe('extractCurrentEnv', () => {
  it('prefers the env-switcher entry config over the header comment', () => {
    const text = [
      '# dsh-sentry 组装（env: tst-platform-hosted-1）——由 apps/agent/envs.yml 生成，勿手改。',
      '  - id: sentry-tool-env-switcher',
      "    name: '@dsh-sentry/tool-env-switcher'",
      '    config:',
      '      env: dev-platform-hosted-0',
    ].join('\n')
    expect(extractCurrentEnv(text)).toBe('dev-platform-hosted-0')
  })

  it('reads the env from the entry config without any header comment', () => {
    const text = [
      '  - id: sentry-tool-env-switcher',
      "    name: '@dsh-sentry/tool-env-switcher'",
      '    config:',
      '      env: tst-client-hosted-0',
    ].join('\n')
    expect(extractCurrentEnv(text)).toBe('tst-client-hosted-0')
  })

  it('falls back to the header comment when no env-switcher entry exists (legacy assemblies)', () => {
    expect(extractCurrentEnv(PATCH_DP0)).toBe('dev-platform-hosted-0')
  })

  it('survives unparsable text via the header fallback', () => {
    const text = '::: not yaml [\n# dsh-sentry 组装（env: dev-client-hosted-0）\n'
    expect(extractCurrentEnv(text)).toBe('dev-client-hosted-0')
  })
})
