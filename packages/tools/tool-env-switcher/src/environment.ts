import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  aliasesForEnv,
  extractCurrentEnv,
  type EnvRow,
  type Matrix,
  renderIncludePatch,
  renderPatch,
  requiredCredentialRefs,
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
    }
  | {
      ok: false
      code: 'UNKNOWN_ENV' | 'MISSING_CREDENTIALS'
      requested: string
      environment?: string
      missingCredentialRefs?: string[]
      credentialStorePath?: string
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
    credentialStorePath: join(dshHome, '.credentials.yaml'),
  }
}

export function readMatrix(path: string): Matrix {
  const parsed = parse(readFileSync(path, 'utf8')) as Matrix | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`环境矩阵不是合法对象: ${path}`)
  }
  return parsed
}

export function knownCredentialKeys(path: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const keys = new Set(Object.keys(env))
  if (!existsSync(path)) return keys
  const store = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null
  if (store !== null && typeof store === 'object' && !Array.isArray(store)) {
    for (const key of Object.keys(store)) keys.add(key)
    // 凭据库实际 schema：凭据嵌套在顶层 refs 映射下（version/refs/records），
    // 仅读顶层键会把所有环境误判为缺凭据
    const refs = store.refs
    if (refs !== null && typeof refs === 'object' && !Array.isArray(refs)) {
      for (const key of Object.keys(refs as Record<string, unknown>)) keys.add(key)
    }
  }
  return keys
}

export function listEnvironments(config: RuntimeConfig): ListResult {
  const matrix = readMatrix(config.envsPath)
  const known = knownCredentialKeys(config.credentialStorePath)
  const current = currentEnvironment(config).current
  return {
    current,
    environments: Object.entries(matrix).map(([name, row]) => {
      const missingCredentialRefs = requiredCredentialRefs(row).filter(ref => !known.has(ref))
      return {
        name,
        aliases: aliasesForEnv(name),
        ready: missingCredentialRefs.length === 0,
        missingCredentialRefs,
        greptimedbEndpoint: row.greptimedb.endpoint,
      }
    }),
  }
}

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
  const known = knownCredentialKeys(config.credentialStorePath)
  const missingCredentialRefs = requiredCredentialRefs(row).filter(ref => !known.has(ref))
  if (missingCredentialRefs.length > 0) {
    return {
      ok: false,
      code: 'MISSING_CREDENTIALS',
      requested,
      environment,
      missingCredentialRefs,
      credentialStorePath: config.credentialStorePath,
      error: `环境 ${environment} 缺少凭据: ${missingCredentialRefs.join(', ')}`,
    }
  }

  const aliases = aliasesForEnv(environment)
  if (options?.dryRun === true) {
    return {
      ok: true,
      environment,
      aliases,
      dryRun: true,
      patch: renderPatch(row),
    }
  }

  const switchedAt = (options?.now ?? (() => new Date().toISOString()))()
  const patch = `${renderPatch(row)}# 环境切换时间: ${switchedAt}\n`
  const includePatch = `${renderIncludePatch(row)}# 环境切换时间: ${switchedAt}\n`
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
  }
}
