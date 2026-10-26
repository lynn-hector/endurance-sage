/**
 * Environment switcher tools.
 *
 * The tools expose list/current/switch operations directly to the model while
 * keeping all writable paths fixed by plugin config. Environment input is
 * restricted to names and aliases defined by apps/agent/envs.yml; endpoint and
 * path injection is not accepted.
 *
 * @module @dsh-sentry/tool-env-switcher
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
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
  env: z.string().required().description('插件加载时的环境标识；文件切换后等待热重载更新'),
  envsPath: z.string().default(defaults.envsPath).description('环境矩阵 YAML 路径'),
  patchPath: z.string().default(defaults.patchPath).description('直写模式 patch 输出路径'),
  includePath: z.string().default(defaults.includePath).description('本地 include 模式输出路径'),
  profilePatchPath: z.string().default(defaults.profilePatchPath).description('当前 dsh profile patch；仅在已是直写装配时同步'),
  credentialStorePath: z.string().default(defaults.credentialStorePath).description('本地凭据库路径'),
})

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function asJson(value: unknown): JsonValue {
  return value as unknown as JsonValue
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
      'List switchable sentry environments, short aliases, credential readiness, and the current assembly. Read-only.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute() {
      return Promise.resolve(asJson(listEnvironments(runtimeConfig)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_env_current',
    description:
      'Read the current environment from the generated assembly and report whether patch hot-reload is still pending.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    execute() {
      return Promise.resolve(asJson(currentEnvironment(runtimeConfig)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_env_switch',
    description:
      'Switch the sentry assembly to another environment from envs.yml. Accepts canonical names or DP0/DP1/DC0/TP0/TP1/TC0/SC1/SC2 aliases; validates all credential refs before writing.',
    parameters: {
      env: { type: 'string', required: true, description: 'Canonical environment name or short alias, e.g. TP1.' },
      dryRun: { type: 'boolean', default: false, description: 'Return the rendered patch without writing files.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute(args) {
      return Promise.resolve(asJson(switchEnvironment(args.env, runtimeConfig, { dryRun: args.dryRun ?? false })))
    },
  }))
}
