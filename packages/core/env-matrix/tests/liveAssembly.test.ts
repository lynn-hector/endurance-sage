import { describe, expect, it } from 'vitest'
import { extractCurrentEnv } from '../src/index.ts'

const PATCH_DP0 = [
  '# dsh-sentry 组装（env: dev-platform-hosted-0）——由 apps/agent/envs.yml 生成，勿手改。',
  '',
  '- insert:',
  '    - id: sentry-tool-trace-analyzer',
  "      name: '@dsh-sentry/tool-trace-analyzer'",
  '      config:',
  '        env: dev-platform-hosted-0',
].join('\n')

describe('extractCurrentEnv', () => {
  it('reads the aggregate bundle defaultEnv before legacy fields', () => {
    const text = [
      '- id: sentry',
      "  name: '@dsh-sentry/sentry'",
      '  config:',
      '    defaultEnv: tst-platform-hosted-1',
    ].join('\n')
    expect(extractCurrentEnv(text)).toBe('tst-platform-hosted-1')
  })

  it('prefers the legacy env-switcher entry config over the header comment', () => {
    const text = [
      '# dsh-sentry 组装（env: tst-platform-hosted-1）——由 apps/agent/envs.yml 生成，勿手改。',
      '  - id: sentry-tool-env-switcher',
      "    name: '@dsh-sentry/tool-env-switcher'",
      '    config:',
      '      env: dev-platform-hosted-0',
    ].join('\n')
    expect(extractCurrentEnv(text)).toBe('dev-platform-hosted-0')
  })

  it('falls back to the header comment for legacy assemblies', () => {
    expect(extractCurrentEnv(PATCH_DP0)).toBe('dev-platform-hosted-0')
  })

  it('survives unparsable text via the header fallback', () => {
    const text = '::: not yaml [\n# dsh-sentry 组装（env: dev-client-hosted-0）\n'
    expect(extractCurrentEnv(text)).toBe('dev-client-hosted-0')
  })
})
