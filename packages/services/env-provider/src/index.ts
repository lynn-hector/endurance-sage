import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionCallContext } from '@dsh-sentry/env-binding'
import { defaultEnvsPath } from '@dsh-sentry/env-matrix'
import z from '@deepseek-ai/schemastery'
import { EnvProviderPool, type EnvProviderLease } from './pool.ts'

export interface Config {
  envsPath?: string
}

/**
 * Stable Tool-facing entry for Session-routed Providers.
 *
 * The pool owns environment resources; this facade only combines the durable
 * Session route with a leased Provider snapshot for one call.
 */
export class SessionEnvProviders extends Service {
  static inject = ['envBinding']

  static Config: z<Config> = z.object({
    envsPath: z.string().default(defaultEnvsPath()).description('环境矩阵 YAML 路径'),
  })

  private readonly pool: EnvProviderPool

  constructor(ctx: Context, config: Config) {
    super(ctx, 'envProviders')
    this.pool = new EnvProviderPool(ctx, { envsPath: config.envsPath ?? defaultEnvsPath() })
    ctx.effect(() => () => this.pool.dispose(), 'dispose environment Provider pool')
  }

  async forCall(exec: SessionCallContext): Promise<EnvProviderLease> {
    const binding = await this.ctx.envBinding.forCall(exec)
    return this.pool.acquire(binding.env)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    envProviders: SessionEnvProviders
  }
}

export { EnvProviderPool } from './pool.ts'
export type { EnvProviderBundle, EnvProviderLease } from './pool.ts'
export default SessionEnvProviders
