import { Context, Service } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { SentrySettingsService } from '../src/index.ts'

class FakeEnvBinding extends Service {
  constructor(ctx: Context) {
    super(ctx, 'envBinding')
  }

  defaultEnv() {
    return {
      preference: 'dev-platform-hosted-0',
      effectiveEnv: 'dev-platform-hosted-0',
      assemblyEnv: 'tst-platform-hosted-0',
    }
  }

  globalConfig() {
    return { codeBaseDir: '/store/novoone-backend' }
  }
}

describe('SentrySettingsService', () => {
  it('exposes the non-secret default environment and global config through Remote methods', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeEnvBinding)
    await ctx.plugin(SentrySettingsService)

    const methods = remoteMethods(ctx.sentrySettings).map(method => method.method)
    expect(methods).toContain('getDefaultEnv')
    expect(methods).toContain('getGlobalConfig')
    expect(ctx.sentrySettings.getDefaultEnv()).toEqual({
      preference: 'dev-platform-hosted-0',
      effectiveEnv: 'dev-platform-hosted-0',
      assemblyEnv: 'tst-platform-hosted-0',
    })
    expect(ctx.sentrySettings.getGlobalConfig()).toEqual({ codeBaseDir: '/store/novoone-backend' })
    await ctx.fiber.dispose()
  })
})
