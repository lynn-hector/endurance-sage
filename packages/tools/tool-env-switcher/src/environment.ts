import { resolve } from 'node:path'
import {
  aliasesForEnv,
  credentialReadiness,
  credentialStorePath,
  defaultEnvsPath,
  readMatrix,
} from '@dsh-sentry/env-matrix'

export { readMatrix } from '@dsh-sentry/env-matrix'

/**
 * Session-routed environment listing: the matrix and per-leg credential
 * readiness shared by `sentry_env_list`. "Current" is per calling session and
 * resolved from its durable binding by the tool, never from assembly files.
 */
export interface RuntimeConfig {
  envsPath: string
  credentialStorePath: string
}

export interface ListResult {
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

export function resolveRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    envsPath: resolve(config.envsPath),
    credentialStorePath: resolve(config.credentialStorePath),
  }
}

export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    envsPath: defaultEnvsPath(),
    credentialStorePath: credentialStorePath(),
  }
}

export function listEnvironments(config: RuntimeConfig): ListResult {
  const matrix = readMatrix(config.envsPath)
  return {
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
