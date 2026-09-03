/**
 * Shared environment matrix model and Cordis assembly renderer.
 *
 * `apps/agent/envs.yml` remains the only hand-maintained source. The CLI and
 * the model-facing environment switcher both consume this module so their
 * rendered plugin lists cannot drift.
 *
 * @module @dsh-sentry/env-matrix
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

export interface EnvLeg {
  endpoint?: string
  database?: string
  /** Prometheus 数据源 uid（仅 prometheus 腿使用） */
  datasourceUid?: string
  /** Grafana 内 GreptimeDB-Jaeger 数据源的 uid（仅 grafana 腿使用，uid 随环境漂移） */
  greptimedbJaegerDatasourceUid?: string
  project?: string
  envName?: string
  usernameRef?: string
  passwordRef?: string
  tokenRef?: string
}

export interface EnvRow {
  envLabel: string
  greptimedb: EnvLeg
  grafana: EnvLeg
  prometheus: EnvLeg
  dbx: EnvLeg
  rocketmq: EnvLeg
  zadig: EnvLeg
  db?: { database?: string }
  codeRepository?: { baseDir?: string }
}

export interface Matrix {
  [env: string]: EnvRow
}

export const ENV_ALIASES: Readonly<Record<string, string>> = {
  DP0: 'dev-platform-hosted-0',
  DP1: 'dev-platform-hosted-1',
  DC0: 'dev-client-hosted-0',
  TP0: 'tst-platform-hosted-0',
  TP1: 'tst-platform-hosted-1',
  TC0: 'tst-client-hosted-0',
  SC1: 'sit-client-hosted-1',
  SC2: 'sit-client-hosted-2',
}

const DEFAULT_DB_DATABASE = 'novo_commctl_config'

type Entry = { id: string; name: string; config?: Record<string, unknown> }

/** Anchors env detection: present in every assembly, always carries `config.env`. */
const ENV_SWITCHER_ENTRY_ID = 'sentry-tool-env-switcher'

export function resolveEnvName(input: string, matrix: Matrix): string | undefined {
  if (Object.hasOwn(matrix, input)) return input
  const canonical = ENV_ALIASES[input.toUpperCase()]
  return canonical !== undefined && Object.hasOwn(matrix, canonical) ? canonical : undefined
}

export function aliasesForEnv(name: string): string[] {
  return Object.entries(ENV_ALIASES)
    .filter(([, canonical]) => canonical === name)
    .map(([alias]) => alias)
}

export function requiredCredentialRefs(row: EnvRow): string[] {
  return [
    row.greptimedb.usernameRef,
    row.greptimedb.passwordRef,
    row.grafana.usernameRef,
    row.grafana.passwordRef,
    row.dbx.passwordRef,
    row.rocketmq.usernameRef,
    row.rocketmq.passwordRef,
    row.zadig.tokenRef,
    row.prometheus.tokenRef,
  ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
}

/**
 * Default credential store location: `$DSH_HOME/.credentials.yaml`, else
 * `~/.dsh/.credentials.yaml`. Shared by the CLI, the env-switcher tool, and
 * store-backed config resolution below.
 */
export function credentialStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * Flat view of the credential store: top-level keys plus keys nested under
 * `refs:` (the dsh-managed `version`/`refs`/`records` schema). Values are
 * returned as-is; callers decide how to interpret them.
 */
function readCredentialStore(storePath: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  if (!existsSync(storePath)) return merged
  const store = parse(readFileSync(storePath, 'utf8')) as Record<string, unknown> | null
  if (store === null || typeof store !== 'object' || Array.isArray(store)) return merged
  Object.assign(merged, store)
  const refs = store['refs']
  if (refs !== null && typeof refs === 'object' && !Array.isArray(refs)) {
    Object.assign(merged, refs as Record<string, unknown>)
  }
  return merged
}

/**
 * Collect the credential key names the local credential provider would
 * resolve from: the store file at `storePath` plus the process environment.
 */
export function knownCredentialKeys(storePath: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const keys = new Set(Object.keys(env))
  for (const key of Object.keys(readCredentialStore(storePath))) keys.add(key)
  return keys
}

/**
 * Resolve the code-search base dir. Three machine-local sources, highest
 * precedence first:
 *
 * 1. an explicit `codeRepository.baseDir` row in envs.yml (committed team
 *    config);
 * 2. the `DSH_SENTRY_CODE_BASE` environment variable (server deploys,
 *    one-off runs);
 * 3. the `DSH_SENTRY_CODE_BASE` key in the credential store — one
 *    machine-local file for everything dsh-sentry reads (paths are not
 *    secrets; dsh itself only resolves `*Ref` keys and ignores the rest).
 *
 * No hardcoded fallback: an unset value leaves the code leg unconfigured,
 * the CLI warns, and the plugin reports an actionable message.
 */
export function resolveCodeBaseDir(row?: Pick<EnvRow, 'codeRepository'>): string | undefined {
  const fromStore = readCredentialStore(credentialStorePath())['DSH_SENTRY_CODE_BASE']
  const value = row?.codeRepository?.baseDir
    ?? process.env.DSH_SENTRY_CODE_BASE
    ?? (typeof fromStore === 'string' ? fromStore : undefined)
  return value === '' ? undefined : value
}

export function renderEntries(row: EnvRow): Entry[] {
  const env = row.envLabel
  const codeBaseDir = resolveCodeBaseDir(row)
  return [
    {
      id: ENV_SWITCHER_ENTRY_ID,
      name: '@dsh-sentry/tool-env-switcher',
      config: { env },
    },
    {
      id: 'sentry-greptimedb',
      name: '@dsh-sentry/service-greptimedb',
      config: {
        endpoint: row.greptimedb.endpoint,
        database: row.greptimedb.database ?? 'public',
        usernameRef: row.greptimedb.usernameRef,
        passwordRef: row.greptimedb.passwordRef,
      },
    },
    { id: 'sentry-tool-log-analyzer', name: '@dsh-sentry/tool-log-analyzer' },
    {
      id: 'sentry-trace',
      name: '@dsh-sentry/service-trace',
      config: {
        mode: 'grafana-jaeger',
        endpoint: row.grafana.endpoint,
        usernameRef: row.grafana.usernameRef,
        passwordRef: row.grafana.passwordRef,
      },
    },
    {
      id: 'sentry-tool-trace-analyzer',
      name: '@dsh-sentry/tool-trace-analyzer',
      config: { greptimedbJaegerDatasourceUid: row.grafana.greptimedbJaegerDatasourceUid },
    },
    {
      id: 'sentry-prometheus',
      name: '@dsh-sentry/service-prometheus',
      config: {
        grafanaEndpoint: row.grafana.endpoint,
        datasourceUid: row.prometheus.datasourceUid,
        // 默认走 grafana 账号密码的表单登录+session（service 端实现，禁
        // basic auth 的实例也可用）；显式配 tokenRef 时 Bearer 优先——保留为
        // 单环境覆盖的逃生口，当前 envs.yml 没有环境使用
        ...(row.prometheus.tokenRef !== undefined
          ? { tokenRef: row.prometheus.tokenRef }
          : { usernameRef: row.grafana.usernameRef, passwordRef: row.grafana.passwordRef }),
      },
    },
    { id: 'sentry-tool-metrics-inspector', name: '@dsh-sentry/tool-metrics-inspector' },
    {
      id: 'sentry-dbx',
      name: '@dsh-sentry/service-dbx',
      config: {
        endpoint: row.dbx.endpoint,
        passwordRef: row.dbx.passwordRef,
      },
    },
    {
      id: 'sentry-tool-db-inspector',
      name: '@dsh-sentry/tool-db-inspector',
      config: { database: row.db?.database ?? DEFAULT_DB_DATABASE },
    },
    { id: 'sentry-tool-redis-inspector', name: '@dsh-sentry/tool-redis-inspector' },
    {
      id: 'sentry-zadig',
      name: '@dsh-sentry/service-zadig',
      config: {
        endpoint: row.zadig.endpoint,
        project: row.zadig.project,
        envName: row.zadig.envName,
        tokenRef: row.zadig.tokenRef,
      },
    },
    { id: 'sentry-tool-zadig-inspector', name: '@dsh-sentry/tool-zadig-inspector' },
    {
      id: 'sentry-service-rocketmq',
      name: '@dsh-sentry/service-rocketmq',
      config: {
        endpoint: row.rocketmq.endpoint,
        usernameRef: row.rocketmq.usernameRef,
        passwordRef: row.rocketmq.passwordRef,
      },
    },
    { id: 'sentry-tool-mq-inspector', name: '@dsh-sentry/tool-mq-inspector' },
    {
      id: 'sentry-tapd',
      name: '@dsh-sentry/service-tapd',
      config: {
        workspaceId: '63822673',
        tokenRef: 'TAPD_TOKEN',
      },
    },
    { id: 'sentry-tool-tapd-inspector', name: '@dsh-sentry/tool-tapd-inspector' },
    {
      id: 'sentry-tool-code-repository',
      name: '@dsh-sentry/tool-code-repository',
      config: codeBaseDir === undefined ? undefined : { baseDir: codeBaseDir },
    },
    { id: 'sentry-persona', name: '@dsh-sentry/sentry-persona' },
    { id: 'sentry-skills', name: '@dsh-sentry/sentry-skills' },
    { id: 'sentry-git-guard', name: '@dsh-sentry/guard-git' },
  ]
}

/** Regeneration pointer shared by both assembly headers: don't hand-edit, change the source. */
const REGEN_NOTE = '# 修改入口：apps/agent/envs.yml；重新生成：pnpm --filter @dsh-sentry/agent run regenerate'

export function renderPatch(row: EnvRow): string {
  const header = [
    `# dsh-sentry 组装（env: ${row.envLabel}）——由 apps/agent/envs.yml 生成，勿手改。`,
    REGEN_NOTE,
  ].join('\n')
  return `${header}\n\n- insert:\n${stringifyEntries(renderEntries(row))}\n`
}

export function renderIncludePatch(row: EnvRow): string {
  const header = [
    `# dsh-sentry 组装（env: ${row.envLabel}，include 格式）——由 apps/agent/envs.yml 生成，勿手改。`,
    REGEN_NOTE,
  ].join('\n')
  return `${header}\n${stringifyEntries(renderEntries(row), '  ')}\n`
}

/**
 * The environment an assembly text declares.
 *
 * Structural source first: the env-switcher entry's `config.env` — real YAML
 * the renderer emits and the loader consumes; editing or losing the comment
 * header cannot desync it. The header comment remains the human summary and
 * the legacy fallback for assemblies written before this convention.
 */
export function extractCurrentEnv(text: string): string | undefined {
  try {
    const entry = assemblyEntries(parse(text))?.find(item => item.id === ENV_SWITCHER_ENTRY_ID)
    const env = entry?.config?.['env']
    if (typeof env === 'string' && env.length > 0) return env
  } catch {
    // unparseable text — the header fallback below still gets a chance
  }
  return /^# dsh-sentry 组装（env: (.+?)(?:，include 格式)?）/m.exec(text)?.[1]
}

// ---------------------------------------------------------------------------
// Live assembly reading — call-time truth for evidence labels and env-bound
// tool config.
//
// Why this exists: replacing a service plugin's config does not restart the
// tool plugins that inject that service (cordis `Fiber.update`'s non-active
// branch stashes the new config silently, with no log). A tool plugin frozen
// this way keeps answering with its boot-time config, so anything
// environment-bound in `Config` — the `env` evidence label, the Jaeger
// datasource uid, the postgres database — can go stale after
// `sentry_env_switch`. The assembly files are the single source of truth the
// switcher rewrites atomically, so tools read them per call and fall back to
// plugin config only when the files are unreachable.
// ---------------------------------------------------------------------------

/** Locations of the two generated assembly files, checked in this order. */
export interface AssemblyPaths {
  /** Include-format assembly (`cordis.include.yml`), preferred source. */
  include: string
  /** Direct-write patch assembly (`cordis.patch.yml`). */
  patch: string
}

/** Repo-relative default assembly locations (`apps/profile/*`), or `$DSH_SENTRY_ASSEMBLY_DIR` when set. */
export function defaultAssemblyPaths(): AssemblyPaths {
  const override = process.env.DSH_SENTRY_ASSEMBLY_DIR
  if (override !== undefined && override.length > 0) {
    return {
      include: join(override, 'cordis.include.yml'),
      patch: join(override, 'cordis.patch.yml'),
    }
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  return {
    include: join(repoRoot, 'apps/profile/cordis.include.yml'),
    patch: join(repoRoot, 'apps/profile/cordis.patch.yml'),
  }
}

/** Assembly entries flattened from either file format (bare list or `- insert:`). */
function assemblyEntries(parsed: unknown): Entry[] | undefined {
  if (!Array.isArray(parsed)) return undefined
  const entries: Entry[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const insert = (item as { insert?: unknown }).insert
    if (Array.isArray(insert)) {
      for (const entry of insert) {
        if (isEntry(entry)) entries.push(entry)
      }
      continue
    }
    if (isEntry(item)) entries.push(item)
  }
  return entries.length > 0 ? entries : undefined
}

function isEntry(value: unknown): value is Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Entry).id === 'string'
}

/**
 * The environment the assembly files currently declare — the value
 * `sentry_env_switch` last wrote. Returns `undefined` when neither file is
 * readable or parseable; callers fall back to plugin config.
 */
export function liveAssemblyEnv(paths: AssemblyPaths = defaultAssemblyPaths()): string | undefined {
  for (const file of [paths.include, paths.patch]) {
    try {
      const env = extractCurrentEnv(readFileSync(file, 'utf8'))
      if (env !== undefined) return env
    } catch {
      // unreadable file — try the next source
    }
  }
  return undefined
}

/**
 * One plugin entry's config from the current assembly files. Tools use this
 * to resolve env-bound knobs (e.g. the Jaeger datasource uid) at call time
 * instead of trusting their possibly-frozen plugin config.
 */
export function liveAssemblyEntryConfig(
  entryId: string,
  paths: AssemblyPaths = defaultAssemblyPaths(),
): Record<string, unknown> | undefined {
  for (const file of [paths.include, paths.patch]) {
    try {
      const entries = assemblyEntries(parse(readFileSync(file, 'utf8')))
      if (entries === undefined) continue
      const hit = entries.find((entry) => entry.id === entryId)
      if (hit !== undefined && hit.config !== undefined) return hit.config
    } catch {
      // unparsable file — try the next source
    }
  }
  return undefined
}

function stringifyEntries(entries: Entry[], indent = '    '): string {
  return entries
    .map((entry) => {
      const lines = [`${indent}- id: ${entry.id}`, `${indent}  name: '${entry.name}'`]
      if (entry.config) {
        lines.push(`${indent}  config:`)
        for (const [key, value] of Object.entries(entry.config)) {
          lines.push(`${indent}    ${key}: ${yamlScalar(value)}`)
        }
      }
      return lines.join('\n')
    })
    .join('\n')
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return stringify(value).trimEnd()
  return String(value)
}
