/**
 * Environment switcher tools.
 *
 * Session-routed hosts (the sentry profile) resolve everything through the
 * `envBinding` service: switch rebinds only the calling DSH session
 * (`exec.agent.session`), current reports that session's durable binding, and
 * list interprets "current" per calling session. Legacy hosts without
 * `@dsh-sentry/env-binding` keep the global assembly-file behaviour.
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
  currentEnvironment,
  defaultRuntimeConfig,
  listEnvironments,
  resolveRuntimeConfig,
  switchEnvironment,
} from './environment.ts'

export * from './environment.ts'

export const name = 'tool-env-switcher'

export const inject = ['tools']

export interface Config {
  env: string
  envsPath?: string
  patchPath?: string
  includePath?: string
  profilePatchPath?: string
  credentialStorePath?: string
}

const defaults = defaultRuntimeConfig('')

export const Config: z<Config> = z.object({
  env: z.string().required().description('旧全局装配的环境标识；仅无 envBinding 宿主的回退路径使用'),
  envsPath: z.string().default(defaults.envsPath).description('环境矩阵 YAML 路径；仅旧全局回退路径使用'),
  patchPath: z.string().default(defaults.patchPath).description('直写模式 patch 输出路径；仅旧全局回退路径使用'),
  includePath: z.string().default(defaults.includePath).description('本地 include 模式输出路径；仅旧全局回退路径使用'),
  profilePatchPath: z.string().default(defaults.profilePatchPath).description('当前 dsh profile patch；仅旧全局回退路径使用'),
  credentialStorePath: z.string().default(defaults.credentialStorePath).description('本地凭据库路径；仅旧全局回退路径使用'),
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
    env: config.env,
    envsPath: config.envsPath ?? defaults.envsPath,
    patchPath: config.patchPath ?? defaults.patchPath,
    includePath: config.includePath ?? defaults.includePath,
    profilePatchPath: config.profilePatchPath ?? defaults.profilePatchPath,
    credentialStorePath: config.credentialStorePath ?? defaults.credentialStorePath,
  })

  ctx.tools.register(defineTool({
    name: 'sentry_env_list',
    description:
      'List switchable sentry environments, short aliases, credential readiness, and the calling session\'s current binding. Read-only.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(_args, exec) {
      const binding = ctx.get('envBinding')
      if (binding !== undefined) {
        const session = exec.agent?.session
        if (session === undefined) return failure(sessionRequired())
        const current = await binding.current(session)
        // Same matrix/readiness listing as the legacy path; only "current" is
        // reinterpreted from this session's durable binding.
        return asJson({ ...listEnvironments(runtimeConfig), current: current.env })
      }
      return asJson(listEnvironments(runtimeConfig))
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
      const binding = ctx.get('envBinding')
      if (binding !== undefined) {
        const session = exec.agent?.session
        if (session === undefined) return failure(sessionRequired())
        try {
          const resolved = await binding.current(session)
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
      }
      return asJson(currentEnvironment(runtimeConfig))
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
      const binding = ctx.get('envBinding')
      if (binding !== undefined) {
        const session = exec.agent?.session
        if (session === undefined) return failure(sessionRequired())
        try {
          const result = await binding.switch(session, { env: args.env, dryRun: args.dryRun ?? false }, 'tool')
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
      }
      return asJson(switchEnvironment(args.env, runtimeConfig, { dryRun: args.dryRun ?? false }))
    },
  }))
}
