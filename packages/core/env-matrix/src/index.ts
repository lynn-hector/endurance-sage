/**
 * Shared environment matrix model and Cordis assembly renderer.
 *
 * `apps/agent/envs.yml` remains the only hand-maintained source. The CLI and
 * the model-facing environment switcher both consume this module so their
 * rendered plugin lists cannot drift.
 *
 * @module @dsh-sentry/env-matrix
 */

import { stringify } from 'yaml'

export interface EnvLeg {
  endpoint?: string
  database?: string
  datasourceUid?: string
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
}

const DEFAULT_DB_DATABASE = 'novo_commctl_config'
const DEFAULT_CODE_BASE_DIR = process.env.DSH_SENTRY_CODE_BASE
  ?? '/Users/yangfm/workspace/work/novo-one/novo-commctl'

type Entry = { id: string; name: string; config?: Record<string, unknown> }

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
  ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
}

export function renderEntries(row: EnvRow): Entry[] {
  const env = row.envLabel
  return [
    {
      id: 'sentry-tool-env-switcher',
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
    { id: 'sentry-tool-log-analyzer', name: '@dsh-sentry/tool-log-analyzer', config: { env } },
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
      config: { env, datasourceUid: row.grafana.datasourceUid },
    },
    {
      id: 'sentry-prometheus',
      name: '@dsh-sentry/service-prometheus',
      config: {
        grafanaEndpoint: row.grafana.endpoint,
        datasourceUid: row.prometheus.datasourceUid,
        usernameRef: row.grafana.usernameRef,
        passwordRef: row.grafana.passwordRef,
      },
    },
    { id: 'sentry-tool-metrics-inspector', name: '@dsh-sentry/tool-metrics-inspector', config: { env } },
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
      config: { env, database: row.db?.database ?? DEFAULT_DB_DATABASE },
    },
    { id: 'sentry-tool-redis-inspector', name: '@dsh-sentry/tool-redis-inspector', config: { env } },
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
    { id: 'sentry-tool-zadig-inspector', name: '@dsh-sentry/tool-zadig-inspector', config: { env } },
    {
      id: 'sentry-service-rocketmq',
      name: '@dsh-sentry/service-rocketmq',
      config: {
        endpoint: row.rocketmq.endpoint,
        usernameRef: row.rocketmq.usernameRef,
        passwordRef: row.rocketmq.passwordRef,
      },
    },
    { id: 'sentry-tool-mq-inspector', name: '@dsh-sentry/tool-mq-inspector', config: { env } },
    {
      id: 'sentry-tapd',
      name: '@dsh-sentry/service-tapd',
      config: {
        workspaceId: '63822673',
        tokenRef: 'TAPD_TOKEN',
      },
    },
    { id: 'sentry-tool-tapd-inspector', name: '@dsh-sentry/tool-tapd-inspector', config: { env } },
    {
      id: 'sentry-tool-code-repository',
      name: '@dsh-sentry/tool-code-repository',
      config: { env, baseDir: row.codeRepository?.baseDir ?? DEFAULT_CODE_BASE_DIR },
    },
    { id: 'sentry-persona', name: '@dsh-sentry/sentry-persona' },
    { id: 'sentry-skills', name: '@dsh-sentry/sentry-skills' },
    { id: 'sentry-git-guard', name: '@dsh-sentry/guard-git' },
  ]
}

export function renderPatch(row: EnvRow): string {
  const header = [
    `# dsh-sentry 组装（env: ${row.envLabel}）——由 apps/agent/envs.yml 生成，勿手改。`,
    '# 手工维护入口：apps/agent/envs.yml；重新生成：pnpm --filter @dsh-sentry/agent run regenerate',
    '# 顺序即依赖顺序：数据源 service 先于其 tool；凭据全部走引用，不出现明文密码。',
  ].join('\n')
  return `${header}\n\n- insert:\n${stringifyEntries(renderEntries(row))}\n`
}

export function renderIncludePatch(row: EnvRow): string {
  const header = [
    `# dsh-sentry 组装（env: ${row.envLabel}，include 格式）——由 apps/agent/envs.yml 生成，勿手改。`,
    '# 供 cordis-plugin-include 按路径引入（本地 profile 模式）；服务器符号链接模式用 cordis.patch.yml。',
  ].join('\n')
  return `${header}\n${stringifyEntries(renderEntries(row), '  ')}\n`
}

export function extractCurrentEnv(text: string): string | undefined {
  return /^# dsh-sentry 组装（env: (.+?)(?:，include 格式)?）/m.exec(text)?.[1]
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
