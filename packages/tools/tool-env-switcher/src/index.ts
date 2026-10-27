/**
 * Environment switcher tools.
 *
 * Everything resolves through the `envBinding` service: switch rebinds only
 * the calling DSH session (`exec.agent.session`), current reports that
 * session's durable binding, and list interprets "current" per calling
 * session. Hosts without `@dsh-sentry/env-binding` are not supported.
 *
 * Environment input is restricted to names and aliases defined by
 * apps/agent/envs.yml; endpoint and path injection is not accepted.
 *
 * @module @dsh-sentry/tool-env-switcher
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { EnvBindingError } from '@dsh-sentry/env-binding'
import { aliasesForEnv } from '@dsh-sentry/env-matrix'
import {
  defaultRuntimeConfig,
  listEnvironments,
  resolveRuntimeConfig,
} from './environment.ts'

export * from './environment.ts'

export const name = 'tool-env-switcher'

export const inject = ['tools', 'envBinding']

export interface Config {
  /**
   * Assembly anchor only: identifies the startup/default environment of the
   * generated assembly (`extractCurrentEnv` reads it; the plugin itself no
   * longer routes by it).
   */
  env: string
  envsPath?: string
  credentialStorePath?: string
}

const defaults = defaultRuntimeConfig()

export const Config: z<Config> = z.object({
  env: z.string().required().description('装配锚点：组装的启动/默认环境标识（extractCurrentEnv 读取；不参与路由）'),
  envsPath: z.string().default(defaults.envsPath).description('环境矩阵 YAML 路径（sentry_env_list 列举用）'),
  credentialStorePath: z.string().default(defaults.credentialStorePath).description('本地凭据库路径（readiness 预检用）'),
})

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function asJson(value: unknown): JsonValue {
  return value as unknown as JsonValue
}

/** Structured failure envelope, mirroring the legacy `UNKNOWN_ENV` shape. */
function failure(error: unknown, requested?: string): JsonValue {
  const code = error instanceof EnvBindingError ? error.code : 'ENV_BINDING_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  return asJson({
    ok: false,
    code,
    ...(requested !== undefined ? { requested } : {}),
    error: message,
  })
}

function sessionRequired(): EnvBindingError {
  return new EnvBindingError(
    'SESSION_REQUIRED',
    '无法从 exec.agent.session 解析调用 Session；Session 环境路由拒绝回退到全局环境',
  )
}

export function apply(ctx: Context, config: Config): void {
  const runtimeConfig = resolveRuntimeConfig({
    envsPath: config.envsPath ?? defaults.envsPath,
    credentialStorePath: config.credentialStorePath ?? defaults.credentialStorePath,
  })

  ctx.tools.register(defineTool({
    name: 'sentry_env_list',
    description:
      'List switchable sentry environments, short aliases, credential readiness, and the calling session\'s current binding. Read-only.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return failure(sessionRequired())
      const current = await ctx.envBinding.current(session)
      // "Current" is reinterpreted from this session's durable binding.
      return asJson({ ...listEnvironments(runtimeConfig), current: current.env })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_env_current',
    description:
      'Report the calling session\'s current environment binding: canonical name, binding source '
      + '(tool/sdk/default/migration/recovery), per-leg credential readiness, and persistence state of the latest binding record.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return failure(sessionRequired())
      try {
        const resolved = await ctx.envBinding.current(session)
        return asJson({
          current: resolved.env,
          source: resolved.source,
          changedAt: resolved.changedAt,
          ...(resolved.recoveredFrom !== undefined ? { recoveredFrom: resolved.recoveredFrom } : {}),
          ...(resolved.persisted !== undefined
            ? {
                persisted: resolved.persisted,
                ...(resolved.persistenceError !== undefined
                  ? { persistenceError: resolved.persistenceError }
                  : {}),
              }
            : {}),
          readiness: resolved.readiness,
          degradedLegs: resolved.degradedLegs,
        })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_env_switch',
    description:
      'Switch the calling session\'s environment binding to another environment from envs.yml. '
      + 'Accepts canonical names or DP0/DP1/DC0/TP0/TP1/TC0/SC1/SC2 aliases; validates credential refs per leg first. '
      + 'Only this session\'s routing changes — other sessions keep their bindings, history stays untouched, '
      + 'and the binding survives runtime restarts.',
    parameters: {
      env: { type: 'string', required: true, description: 'Canonical environment name or short alias, e.g. TP1.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate target and readiness without changing the binding.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return failure(sessionRequired(), args.env)
      try {
        const result = await ctx.envBinding.switch(session, { env: args.env, dryRun: args.dryRun ?? false }, 'tool')
        return asJson({
          ok: true,
          env: result.env,
          previousEnv: result.previousEnv,
          aliases: aliasesForEnv(result.env),
          dryRun: result.dryRun,
          ...(result.dryRun === false
            ? {
                changedAt: result.changedAt,
                persisted: result.persisted,
                ...(result.persistenceError !== undefined
                  ? { persistenceError: result.persistenceError }
                  : {}),
              }
            : {}),
          degradedLegs: result.degradedLegs,
        })
      } catch (error) {
        return failure(error, args.env)
      }
    },
  }))
}
