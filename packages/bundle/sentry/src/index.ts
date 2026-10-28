import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  defaultEnvsPath,
  readMatrix,
  renderEntries,
  resolveEnvName,
} from '@dsh-sentry/env-matrix'

export const name = 'sentry'

export interface Config {
  /** Canonical environment or alias used for new Sessions and evidence fallback. */
  defaultEnv: string
  /** Defaults to the matrix shipped in @dsh-sentry/env-matrix. */
  envsPath?: string
}

export const Config: z<Config> = z.object({
  defaultEnv: z.string().default('dev-platform-hosted-0').description('新 Session 与失效绑定恢复使用的默认环境'),
  envsPath: z.string().default(defaultEnvsPath()).description('环境矩阵 YAML 路径；默认使用 npm 包内置矩阵'),
})

/**
 * Single DSH-facing entry for the versioned plugin set.
 *
 * Internal packages remain independent npm dependencies, but are imported
 * from this package instead of resolved as profile-level loader rows. That
 * distinction matters under pnpm: transitive dependencies are not guaranteed
 * to be resolvable from the profile's own node_modules directory.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const envsPath = config.envsPath ?? defaultEnvsPath()
  const matrix = readMatrix(envsPath)
  const env = resolveEnvName(config.defaultEnv, matrix)
  if (env === undefined) {
    throw new Error(`默认环境 ${config.defaultEnv} 不在环境矩阵 ${envsPath} 中`)
  }
  const row = matrix[env]
  if (row === undefined) throw new Error(`环境矩阵缺少默认环境: ${env}`)

  for (const entry of renderEntries(row)) {
    const module = await import(entry.name)
    const plugin = module.default ?? module
    const entryConfig = { ...entry.config }
    if (entry.id === 'sentry-env-binding' || entry.id === 'sentry-env-provider' || entry.id === 'sentry-tool-env-switcher') {
      entryConfig['envsPath'] = envsPath
    }
    await ctx.plugin(plugin, entryConfig)
  }
}
