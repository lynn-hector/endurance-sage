import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  aliasesForEnv,
  credentialReadiness,
  credentialStorePath,
  extractCurrentEnv,
  type EnvRow,
  type Matrix,
  renderIncludePatch,
  renderPatch,
  resolveEnvName,
} from '@dsh-sentry/env-matrix'

export interface RuntimeConfig {
  env: string
  envsPath: string
  patchPath: string
  includePath: string
  profilePatchPath: string
  credentialStorePath: string
}

export interface ListResult {
  current: string | null
  environments: Array<{
    name: string
    aliases: string[]
    ready: boolean
    missingCredentialRefs: string[]
    /** 凭据缺值的腿名（值感知：空值视为未配置；不拦截切换） */
    degradedLegs: string[]
    greptimedbEndpoint?: string
  }>
}

export type CurrentResult = {
  current: string | null
  loadedEnv: string
  hotReloadPending: boolean
  sourcePath: string | null
}

export type SwitchResult =
  | {
      ok: true
      environment: string
      aliases: string[]
      dryRun: boolean
      patch?: string
      writtenPaths?: string[]
      switchedAt?: string
      /** 凭据缺值的腿（不拦截切换，该腿工具调用时按需报错，补值即恢复） */
      degradedLegs?: Array<{ leg: string; missingRefs: string[] }>
    }
  | {
      ok: false
      code: 'UNKNOWN_ENV'
      requested: string
      error: string
    }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

export function resolveRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    envsPath: resolve(config.envsPath),
    patchPath: resolve(config.patchPath),
    includePath: resolve(config.includePath),
    profilePatchPath: resolve(config.profilePatchPath),
    credentialStorePath: resolve(config.credentialStorePath),
  }
}

export function defaultRuntimeConfig(env: string): RuntimeConfig {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    env,
    envsPath: join(REPO_ROOT, 'apps/agent/envs.yml'),
    patchPath: join(REPO_ROOT, 'apps/profile/cordis.patch.yml'),
    includePath: join(REPO_ROOT, 'apps/profile/cordis.include.yml'),
    profilePatchPath: join(dshHome, 'profiles/web/cordis.patch.yml'),
    credentialStorePath: credentialStorePath(),
  }
}

export function readMatrix(path: string): Matrix {
  const parsed = parse(readFileSync(path, 'utf8')) as Matrix | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`环境矩阵不是合法对象: ${path}`)
  }
  return parsed
}

export function listEnvironments(config: RuntimeConfig): ListResult {
  const matrix = readMatrix(config.envsPath)
  const current = currentEnvironment(config).current
  return {
    current,
    environments: Object.entries(matrix).map(([name, row]) => {
      const legs = credentialReadiness(row, config.credentialStorePath)
      const missingCredentialRefs = legs.flatMap(item => item.missingRefs)
      return {
        name,
        aliases: aliasesForEnv(name),
        ready: missingCredentialRefs.length === 0,
        missingCredentialRefs,
        degradedLegs: legs.filter(item => !item.ok).map(item => item.leg),
        greptimedbEndpoint: row.greptimedb.endpoint,
      }
    }),
  }
}

/**
 * Report the current environment state.
 *
 * Detection semantics (post live-label mitigation):
 * - `current` is the env the assembly files declare — the value
 *   `sentry_env_switch` last wrote; the single source of truth.
 * - `loadedEnv` is this plugin's own config. This plugin injects no data
 *   source service, so a service config swap cannot strand it on boot-time
 *   config; it follows hot reloads reliably.
 * - `hotReloadPending` compares the two. `true` means the reload has not
 *   reached even this plugin — e.g. the patch watcher is dead or a reload
 *   is still in flight. `false` does NOT certify that every plugin instance
 *   has restarted: service-injected tools can stay frozen on boot-time
 *   config (cordis `Fiber.update`'s non-active branch stashes the new
 *   config silently). That freeze is mitigated where it matters — evidence
 *   `env` labels and env-bound tool knobs resolve from the assembly files
 *   at call time (`liveAssemblyEnv` in @dsh-sentry/env-matrix), and the
 *   service plugins themselves hot-reload correctly.
 */
export function currentEnvironment(config: RuntimeConfig): CurrentResult {
  let sourcePath: string | null = config.includePath
  let current: string | null = null
  if (existsSync(config.includePath)) {
    current = extractCurrentEnv(readFileSync(config.includePath, 'utf8')) ?? null
  } else if (existsSync(config.patchPath)) {
    sourcePath = config.patchPath
    current = extractCurrentEnv(readFileSync(config.patchPath, 'utf8')) ?? null
  }
  if (existsSync(config.profilePatchPath)) {
    const profileEnv = extractCurrentEnv(readFileSync(config.profilePatchPath, 'utf8'))
    if (profileEnv !== undefined) {
      sourcePath = config.profilePatchPath
      current = profileEnv
    }
  }
  return {
    current,
    loadedEnv: config.env,
    hotReloadPending: current !== config.env,
    sourcePath,
  }
}

export function switchEnvironment(
  requested: string,
  config: RuntimeConfig,
  options?: { dryRun?: boolean, now?: () => string },
): SwitchResult {
  const matrix = readMatrix(config.envsPath)
  const environment = resolveEnvName(requested, matrix)
  if (environment === undefined) {
    return {
      ok: false,
      code: 'UNKNOWN_ENV',
      requested,
      error: `未知环境: ${requested}；先调用 sentry_env_list 查看可用环境和短名`,
    }
  }

  const row = matrix[environment] as EnvRow
  // 凭据缺值/空值只降级对应腿并随结果返回，不再拒绝切换——该腿工具调用时
  // 按需报错，补值即恢复（预检与渲染共享 @dsh-sentry/env-matrix 单一实现）
  const degradedLegs = credentialReadiness(row, config.credentialStorePath)
    .filter(item => !item.ok)
    .map(item => ({ leg: item.leg, missingRefs: item.missingRefs }))
  const aliases = aliasesForEnv(environment)
  if (options?.dryRun === true) {
    return {
      ok: true,
      environment,
      aliases,
      dryRun: true,
      patch: renderPatch(row),
      ...(degradedLegs.length > 0 ? { degradedLegs } : {}),
    }
  }

  // Switch time is runtime info (returned below), never written into the
  // assembly: the files stay a pure function of envs.yml, so regenerating
  // the same environment is byte-identical (idempotent regenerate, no diff).
  const switchedAt = (options?.now ?? (() => new Date().toISOString()))()
  const patch = renderPatch(row)
  const includePatch = renderIncludePatch(row)
  const writtenPaths = [config.patchPath, config.includePath]
  if (existsSync(config.profilePatchPath)
    && extractCurrentEnv(readFileSync(config.profilePatchPath, 'utf8')) !== undefined) {
    writtenPaths.push(config.profilePatchPath)
  }
  for (const path of writtenPaths) {
    writeFileSync(path, path === config.includePath ? includePatch : patch)
  }
  return {
    ok: true,
    environment,
    aliases,
    dryRun: false,
    writtenPaths,
    switchedAt,
    ...(degradedLegs.length > 0 ? { degradedLegs } : {}),
  }
}
