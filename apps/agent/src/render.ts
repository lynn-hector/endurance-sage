/**
 * Pure rendering: an environment row from apps/agent/envs.yml → the sentry
 * plugin entry list for a cordis.patch.yml `- insert:` layer.
 *
 * The single hand-maintained source is envs.yml; this module turns one row
 * into the same 16-plugin assembly that sentry.cordis.patch.yml has carried
 * since Phase 5 — same ids, same order (services before their tools, persona
 * and skills last), same credential-reference discipline (refs only, never
 * values).
 *
 * @module @dsh-sentry/agent/render
 */

import { stringify } from 'yaml'

/** One datasource leg of an environment row. */
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

/** One environment row of the matrix. */
export interface EnvRow {
  envLabel: string
  greptimedb: EnvLeg
  grafana: EnvLeg
  prometheus: EnvLeg
  dbx: EnvLeg
  rocketmq: EnvLeg
  zadig: EnvLeg
  /** Optional overrides; defaults keep today's assembly values. */
  db?: { database?: string }
  codeRepository?: { baseDir?: string }
}

export interface Matrix {
  [env: string]: EnvRow
}

const DEFAULT_DB_DATABASE = 'novo_commctl_config'
const DEFAULT_CODE_BASE_DIR = '/Users/yangfm/workspace/work/novo-one/novo-commctl'

type Entry = { id: string; name: string; config?: Record<string, unknown> }

/**
 * Every credential key the rendered assembly references for this row — the
 * readiness contract: an environment is switchable iff the store answers for
 * all of these.
 */
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

/** Render the `- insert:` plugin list for one environment row. */
export function renderEntries(row: EnvRow): Entry[] {
  const env = row.envLabel
  return [
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
        // Prometheus 只经 Grafana 数据源代理暴露；直连 endpoint 字段省略
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
        // TAPD 为平台级数据源（唯一缺陷单来源），不随环境切换
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
    {
      // 平台级门禁：拦 bash 工具里的破坏性 git 命令（deny）与影响远端的命令（ask）。
      // 不随环境切换；规则与局限见 packages/guard/git-guard/src/index.ts。
      id: 'sentry-git-guard',
      name: '@dsh-sentry/guard-git',
    },
  ]
}

/** Full patch-file text for one environment row. */
export function renderPatch(row: EnvRow): string {
  const header = [
    `# dsh-sentry 组装（env: ${row.envLabel}）——由 apps/agent/envs.yml 生成，勿手改。`,
    '# 手工维护入口：apps/agent/envs.yml；重新生成：pnpm --filter @dsh-sentry/agent run regenerate',
    '# 顺序即依赖顺序：数据源 service 先于其 tool；凭据全部走引用，不出现明文密码。',
  ].join('\n')
  return `${header}\n\n- insert:\n${stringifyEntries(renderEntries(row))}\n`
}

function stringifyEntries(entries: Entry[], indent = '    '): string {
  // `yaml` package handles the objects; simple line rendering keeps diffs readable.
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
  // Delegate scalar rendering to the yaml package: it quotes any string that
  // would re-parse as another type (numbers like '63822673', booleans, null),
  // which the previous hand-rolled special-character check let through plain.
  if (typeof value === 'string') return stringify(value).trimEnd()
  return String(value)
}
