/**
 * Host half of `@dsh-sentry/ui-settings`.
 *
 * Secret credentials continue through the host's one-way credentials Remote.
 * The default environment is non-secret configuration, so this host service
 * exposes its actual value through a separate, narrow Remote method. The web
 * section can therefore restore the saved environment after a remount instead
 * of reducing it to a boolean `configured` flag.
 *
 * @module @dsh-sentry/ui-settings
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DefaultEnvInfo, GlobalConfigInfo } from '@dsh-sentry/env-binding'

export const name = 'sentry-ui-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sentrySettings: SentrySettingsService
  }
}

export class SentrySettingsService extends TypertRemoteService {
  static inject = ['envBinding']

  constructor(ctx: Context) {
    super(ctx, 'sentrySettings')
  }

  @Remote
  getDefaultEnv(): DefaultEnvInfo {
    return this.ctx.envBinding.defaultEnv()
  }

  @Remote
  getGlobalConfig(): GlobalConfigInfo {
    return this.ctx.envBinding.globalConfig()
  }
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(SentrySettingsService)
}
