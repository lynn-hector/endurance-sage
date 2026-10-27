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
  /** Grafana 内 Alertmanager 数据源的 uid（仅 grafana 腿派生服务使用，缺省 alertmanager） */
  alertmanagerDatasourceUid?: string
  project?: string
  envName?: string
  usernameRef?: string
  passwordRef?: string
  /** 腿特定 token 引用，语义随腿变化：prometheus 腿=Bearer token；greptimedb 腿=dashboard connect token（解密还原账密，见 docs/guides/credentials.md） */
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
  PBO: 'pro-br-saas-aws-eks-novo',
  TPSG0: 'tst-platform-aws-eks-sg-0',
  PUO: 'pro-use-saas-aws-eks-novo',
  PZO: 'pro-za-saas-aws-eks-novo',
  PDO: 'pro-de-saas-aws-eks-novo',
  PSO: 'pro-sg-saas-aws-eks-novo',
  TPDE0: 'tst-platform-aws-eks-de-0',
  TPUS0: 'tst-platform-aws-eks-us-0',
  TPAU0: 'tst-platform-aws-eks-au-0',
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

/** Read the shared YAML environment matrix without interpreting credentials. */
export function readMatrix(path: string): Matrix {
  const parsed = parse(readFileSync(path, 'utf8')) as Matrix | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`环境矩阵不是合法对象: ${path}`)
  }
  return parsed
}

export function aliasesForEnv(name: string): string[] {
  return Object.entries(ENV_ALIASES)
    .filter(([, canonical]) => canonical === name)
    .map(([alias]) => alias)
}

/**
 * All credential refs a row declares — a config-shape contract (envs.yml rows
 * must name every ref they wire; greptimedb dual-config lists both sets).
 * Value-aware runtime readiness (missing/empty degrades the leg, never blocks
 * a switch) lives in {@link credentialReadiness}.
 */
export function requiredCredentialRefs(row: EnvRow): string[] {
  return [
    row.greptimedb.usernameRef,
    row.greptimedb.passwordRef,
    row.greptimedb.tokenRef,
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
  let store: unknown
  try {
    store = parse(readFileSync(storePath, 'utf8'))
  } catch (cause) {
    // 坏文件（如重复键；读失败如权限也算）不炸切换器：按空库处理，全部引用键视为未配置
    console.error(`⚠ 凭据库读取/解析失败，按空库处理: ${storePath}\n  ${cause instanceof Error ? cause.message : String(cause)}`)
    return merged
  }
  if (store === null || typeof store !== 'object' || Array.isArray(store)) return merged
  const record = store as Record<string, unknown>
  Object.assign(merged, record)
  const refs = record['refs']
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
 * Value-aware credential view: keys of the credential store plus process env
 * whose value is a non-empty string. Empty and whitespace-only values count
 * as unconfigured (a present-but-empty key must not satisfy a leg).
 */
export function credentialValues(storePath: string, env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') values.set(key, value)
  }
  for (const [key, value] of Object.entries(readCredentialStore(storePath))) {
    if (typeof value === 'string' && value.trim() !== '') values.set(key, value)
  }
  return values
}

export interface LegReadiness {
  leg: 'greptimedb' | 'grafana' | 'prometheus' | 'dbx' | 'rocketmq' | 'zadig'
  ok: boolean
  /** greptimedb 腿的认证模式，与渲染接线一致：tokenRef 定义即 token，否则账密 */
  authMode?: 'token' | 'basic'
  missingRefs: string[]
}

/**
 * Per-leg credential readiness. Values absent or empty degrade only that leg
 * (`ok: false` + its `missingRefs`) — never a whole-environment refusal; the
 * switcher warns and the leg's tools fail lazily at call time. Only legs that
 * configure refs are evaluated. greptimedb is either/or: with `tokenRef`
 * defined the leg evaluates token mode only (leftover basic refs are ignored,
 * mirroring renderEntries' connectTokenRef-first wiring). A degraded `grafana`
 * leg is wider than its name: trace / prometheus (form login) / alertmanager
 * tools share the grafana credentials and degrade with it.
 */
export function credentialReadiness(
  row: EnvRow,
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): LegReadiness[] {
  const values = credentialValues(storePath, env)
  const evaluate = (
    leg: LegReadiness['leg'],
    refs: Array<string | undefined>,
    authMode?: LegReadiness['authMode'],
  ): LegReadiness => {
    const missingRefs = refs
      .filter((ref): ref is string => ref !== undefined)
      .filter(ref => !values.has(ref))
    return {
      leg,
      ok: missingRefs.length === 0,
      ...(authMode !== undefined ? { authMode } : {}),
      missingRefs,
    }
  }
  const legs: LegReadiness[] = []
  const greptimedbToken = row.greptimedb.tokenRef !== undefined
  const greptimedbHasRefs = greptimedbToken
    || row.greptimedb.usernameRef !== undefined
    || row.greptimedb.passwordRef !== undefined
  if (greptimedbHasRefs) {
    legs.push(evaluate(
      'greptimedb',
      greptimedbToken ? [row.greptimedb.tokenRef] : [row.greptimedb.usernameRef, row.greptimedb.passwordRef],
      greptimedbToken ? 'token' : 'basic',
    ))
  }
  if (row.grafana.usernameRef !== undefined || row.grafana.passwordRef !== undefined) {
    legs.push(evaluate('grafana', [row.grafana.usernameRef, row.grafana.passwordRef]))
  }
  // prometheus 统一走 grafana 表单登录；tokenRef 是单环境 Bearer 逃生口
  if (row.prometheus.tokenRef !== undefined) {
    legs.push(evaluate('prometheus', [row.prometheus.tokenRef], 'token'))
  }
  if (row.dbx.passwordRef !== undefined) legs.push(evaluate('dbx', [row.dbx.passwordRef]))
  if (row.rocketmq.usernameRef !== undefined || row.rocketmq.passwordRef !== undefined) {
    legs.push(evaluate('rocketmq', [row.rocketmq.usernameRef, row.rocketmq.passwordRef]))
  }
  if (row.zadig.tokenRef !== undefined) legs.push(evaluate('zadig', [row.zadig.tokenRef]))
  return legs
}

/**
 * Expand a leading `~` to the user's home dir. Credential-store and env-var
 * values never pass through a shell, so the `~/novoone-backend` form the
 * docs recommend must be expanded here (a literal `~` dir would resolve
 * against every consumer's cwd differently).
 */
export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
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
  return value === undefined || value === '' ? undefined : expandHome(value)
}

export function renderEntries(row: EnvRow): Entry[] {
  const env = row.envLabel
  const codeBaseDir = resolveCodeBaseDir(row)
  return [
    // Session 绑定与 Provider 池是宿主级入口（docs/architecture/session-env-routing.md）：
    // 装配只声明宿主栈与工具，环境 Provider 由 EnvProviderPool 按各 Session
    // 绑定懒创建（renderProviderEntries），不再有全局单例 Provider 条目。
    // defaultEnv 跟随本组装环境，作为新 Session 与失效绑定恢复的 runtime 默认；
    // 矩阵路径由两端共享的 defaultEnvsPath()（支持 DSH_SENTRY_ENVS_PATH 覆盖），
    // 组装不重复该路径。env-switcher 条目的 config.env 是装配环境锚点
    // （extractCurrentEnv/assemblyAnchorEnv 读取），不参与 Session 路由。
    {
      id: 'sentry-env-binding',
      name: '@dsh-sentry/env-binding',
      config: { defaultEnv: env },
    },
    { id: 'sentry-env-provider', name: '@dsh-sentry/service-env-provider' },
    {
      id: ENV_SWITCHER_ENTRY_ID,
      name: '@dsh-sentry/tool-env-switcher',
      config: { env },
    },
    { id: 'sentry-tool-log-analyzer', name: '@dsh-sentry/tool-log-analyzer' },
    { id: 'sentry-tool-callflow-analyzer', name: '@dsh-sentry/tool-callflow-analyzer' },
    { id: 'sentry-tool-trace-analyzer', name: '@dsh-sentry/tool-trace-analyzer' },
    { id: 'sentry-tool-metrics-inspector', name: '@dsh-sentry/tool-metrics-inspector' },
    {
      id: 'sentry-tool-db-inspector',
      name: '@dsh-sentry/tool-db-inspector',
      config: { database: row.db?.database ?? DEFAULT_DB_DATABASE },
    },
    { id: 'sentry-tool-redis-inspector', name: '@dsh-sentry/tool-redis-inspector' },
    { id: 'sentry-tool-zadig-inspector', name: '@dsh-sentry/tool-zadig-inspector' },
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
      id: 'sentry-code-repository',
      name: '@dsh-sentry/service-code-repository',
      config: codeBaseDir === undefined ? undefined : { baseDir: codeBaseDir },
    },
    { id: 'sentry-tool-code-repository', name: '@dsh-sentry/tool-code-repository' },
    { id: 'sentry-persona', name: '@dsh-sentry/sentry-persona' },
    { id: 'sentry-skills', name: '@dsh-sentry/sentry-skills' },
    { id: 'sentry-git-guard', name: '@dsh-sentry/guard-git' },
  ]
}

/**
 * Per-leg Provider service entries one environment mounts inside
 * `EnvProviderPool` — pool-only input, never rendered into a host assembly.
 * The derivation stays shared with `renderEntries`'s single source (envs.yml
 * rows), so a Session-routed Provider can never drift from what a
 * regenerated assembly for the same environment would load.
 */
export function renderProviderEntries(row: EnvRow): Entry[] {
  return [
    {
      id: 'sentry-greptimedb',
      name: '@dsh-sentry/service-greptimedb',
      config: {
        endpoint: row.greptimedb.endpoint,
        database: row.greptimedb.database ?? 'public',
        // token 模式（dashboard connect token 解密为账密）优先；否则账密引用
        ...(row.greptimedb.tokenRef !== undefined
          ? { connectTokenRef: row.greptimedb.tokenRef }
          : { usernameRef: row.greptimedb.usernameRef, passwordRef: row.greptimedb.passwordRef }),
        logSchema: 'public',
        logTable: 'k8s_logs',
        logTimestampCol: 'greptime_timestamp',
        callflowSchema: 'public',
        callflowTable: 'hep_1',
        callflowTimestampCol: 'greptime_timestamp',
      },
    },
    {
      id: 'sentry-trace',
      name: '@dsh-sentry/service-trace',
      config: {
        mode: 'grafana-jaeger',
        endpoint: row.grafana.endpoint,
        usernameRef: row.grafana.usernameRef,
        passwordRef: row.grafana.passwordRef,
        datasourceUid: row.grafana.greptimedbJaegerDatasourceUid,
      },
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
    {
      id: 'sentry-alertmanager',
      name: '@dsh-sentry/service-alertmanager',
      config: {
        grafanaEndpoint: row.grafana.endpoint,
        datasourceUid: row.grafana.alertmanagerDatasourceUid ?? 'alertmanager',
        usernameRef: row.grafana.usernameRef,
        passwordRef: row.grafana.passwordRef,
      },
    },
    {
      id: 'sentry-dbx',
      name: '@dsh-sentry/service-dbx',
      config: {
        endpoint: row.dbx.endpoint,
        passwordRef: row.dbx.passwordRef,
      },
    },
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
    {
      id: 'sentry-service-rocketmq',
      name: '@dsh-sentry/service-rocketmq',
      config: {
        endpoint: row.rocketmq.endpoint,
        usernameRef: row.rocketmq.usernameRef,
        passwordRef: row.rocketmq.passwordRef,
      },
    },
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
// Assembly anchor reading — the startup/default environment an assembly
// declares.
//
// After the Session refactor the only consumers are env-agnostic shared
// services (TAPD, code repositories), which label their evidence with the
// host assembly's anchor env. Reading per call — instead of trusting plugin
// config — keeps the label correct even when a service config swap leaves a
// tool plugin frozen on its boot-time config (cordis `Fiber.update`'s
// non-active branch stashes the new config silently, with no log).
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

/**
 * Repo-relative default matrix location (`apps/agent/envs.yml`), or
 * `$DSH_SENTRY_ENVS_PATH` when set. Shared by the Session binding store and
 * the environment Provider pool so a profile assembly never needs to repeat
 * the path.
 */
export function defaultEnvsPath(): string {
  const override = process.env.DSH_SENTRY_ENVS_PATH
  if (override !== undefined && override.length > 0) return override
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  return join(repoRoot, 'apps/agent/envs.yml')
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
 * The startup/default environment the assembly files declare — the anchor
 * written when `use-env` generated them (env-switcher `config.env`); runtime
 * switching no longer rewrites these files. Returns `undefined` when neither
 * file is readable or parseable; callers fall back to plugin config.
 */
export function assemblyAnchorEnv(paths: AssemblyPaths = defaultAssemblyPaths()): string | undefined {
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

export * from './codegraph.ts'
