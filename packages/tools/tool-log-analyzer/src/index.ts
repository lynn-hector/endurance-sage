/**
 * Log analyzer tools: query k8s container logs from GreptimeDB and extract
 * anomaly patterns, returning the unified evidence envelope.
 *
 * Port of the original `skills/log-analyzer` (SKILL.md + fetch_logs.py). The
 * twenty-odd CLI flags collapse into two JSON-Schema tools:
 * - `sentry_query_logs` — the main log query (`--service/--start/--end/--keywords/--filter/--filter-or/--limit/--log-type`);
 * - `sentry_list_log_services` — workload discovery (`--list-services`).
 *
 * Structural knobs that were CLI flags but describe the environment rather
 * than a single query (`--schema`, `--table`, lookback window, pattern
 * extraction depth) moved into this plugin's `Config`. `--env` became the
 * `env` label in `Config`: the environment is an assembly-time choice now,
 * and the label survives only as evidence metadata.
 *
 * @module @dsh-sentry/tool-log-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type {} from '@dsh-sentry/service-greptimedb'
import { extractLogPatterns } from './patterns.ts'
import { ALLOWED_LOG_FIELDS, buildListServicesSql, buildLogQuerySql } from './sql.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-log-analyzer'

/** The seams this plugin registers into. */
export const inject = ['tools', 'greptimedb']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /**
   * Environment label (`local` / `staging` / `production`). Assembly-time
   * metadata only: it lands in evidence summaries and never switches anything
   * at runtime — the loaded datasource config already is one environment.
   */
  env: string
  /** GreptimeDB schema of the log table. Defaults to `public`. */
  schema?: string
  /** GreptimeDB log table. Defaults to `k8s_logs`. */
  table?: string
  /** Timestamp column used for range filters and ordering. Defaults to `greptime_timestamp`. */
  timestampCol?: string
  /** Lookback window (minutes) for `sentry_list_log_services`. Defaults to 30. */
  lookbackMinutes?: number
  /** Row cap for `sentry_list_log_services`. Defaults to 200. */
  listServicesLimit?: number
  /** How many aggregated patterns a query returns. Defaults to 5. */
  patternsTopN?: number
}

export const Config: z<Config> = z.object({
  env: z.string().required().description('环境标识（local/staging/production），仅作为 evidence 元数据'),
  schema: z.string().default('public').description('日志表所在 schema'),
  table: z.string().default('k8s_logs').description('日志表名'),
  timestampCol: z.string().default('greptime_timestamp').description('时间范围过滤列'),
  lookbackMinutes: z.number().step(1).min(1).default(30).description('服务发现的回看窗口（分钟）'),
  listServicesLimit: z.number().step(1).min(1).default(200).description('服务发现的行数上限'),
  patternsTopN: z.number().step(1).min(1).default(5).description('聚合模式返回个数'),
})

const SOURCE = 'log-analyzer'
const TYPE = 'log'
const DEFAULT_LIMIT = 1000
const DEFAULT_LOG_TYPE = 'go'

const FILTER_DSL_GUIDE =
  '过滤 DSL：`field=value` / `field!=value` / `field LIKE value` / `field NOT LIKE value` / '
  + '`field IS NULL` / `field IS NOT NULL`。LIKE 的 value 不自动加 `%`。'
  + `允许字段: ${[...ALLOWED_LOG_FIELDS].sort().join(', ')}`

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register the two log tools. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env
  const schema = config.schema ?? 'public'
  const table = config.table ?? 'k8s_logs'
  const timestampCol = config.timestampCol ?? 'greptime_timestamp'
  const evidenceRefs = (): string[] => [`env:${liveEnv()}`, `greptimedb:${table}`]

  ctx.tools.register(defineTool({
    name: 'sentry_query_logs',
    description:
      'Query k8s container logs from GreptimeDB and extract recurring anomaly patterns. '
      + 'Read-only. Prefer a tight time window (5–15 minutes around the symptom). '
      + 'When unsure which workloads produce logs, call sentry_list_log_services first. '
      + FILTER_DSL_GUIDE,
    parameters: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workload names (mapped to workload_name). Omit to query all services — expensive.',
      },
      start: { type: 'string', required: true, description: 'Range start, ISO8601 (e.g. 2026-07-27T10:00:00Z).' },
      end: { type: 'string', required: true, description: 'Range end, ISO8601.' },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keywords OR-matched against message (LIKE %kw%). e.g. ["ERROR", "timeout"].',
      },
      filters: {
        type: 'array',
        items: { type: 'string' },
        description: `AND-connected filter DSL expressions. ${FILTER_DSL_GUIDE}`,
      },
      filterOr: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter DSL expressions OR-ed into one block, AND-ed as a whole.',
      },
      limit: { type: 'integer', default: DEFAULT_LIMIT, description: `Max rows returned. Defaults to ${DEFAULT_LIMIT}.` },
      logType: { type: 'string', default: DEFAULT_LOG_TYPE, description: `Log type filter (go/nginx/java). Defaults to ${DEFAULT_LOG_TYPE}.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const logType = args.logType ?? DEFAULT_LOG_TYPE
      const limit = args.limit ?? DEFAULT_LIMIT
      const services = args.services?.map(service => service.trim()).filter(service => service.length > 0)
      const serviceLabel = services?.join(',') ?? ''

      let sql: string
      try {
        sql = buildLogQuerySql({
          ...services !== undefined && services.length > 0 ? { services } : {},
          start: args.start,
          end: args.end,
          ...args.keywords !== undefined ? { keywords: args.keywords } : {},
          limit,
          logType,
          schema,
          table,
          timestampCol,
          ...args.filters !== undefined && args.filters.length > 0 ? { filters: args.filters } : {},
          ...args.filterOr !== undefined && args.filterOr.length > 0 ? { filterOr: args.filterOr } : {},
        })
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: `SQL 拼接失败: ${errorMessage(error)}`,
          summary: `查询失败: SQL 拼接失败: ${errorMessage(error)}`,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      }

      try {
        const logs = await ctx.greptimedb.query(sql)
        const patterns = extractLogPatterns(logs, { topN: config.patternsTopN ?? 5, timestampCol })
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            service: serviceLabel,
            start: args.start,
            end: args.end,
            sql,
            logs,
            patterns,
          },
          summary:
            `env=${liveEnv()} service=${serviceLabel} 时间窗 [${args.start}, ${args.end}] `
            + `返回 ${logs.length} 条日志，提取 ${patterns.length} 个模式。`,
          confidence: logs.length > 0 ? 0.8 : 0.4,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            service: serviceLabel,
            start: args.start,
            end: args.end,
            sql,
            error: errorMessage(error),
          },
          summary: `查询失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_list_log_services',
    description:
      'List every workload (service) that produced logs in the recent lookback window. '
      + 'Use this to discover exact service names before calling sentry_query_logs. Read-only.',
    parameters: {
      logType: { type: 'string', default: DEFAULT_LOG_TYPE, description: `Log type filter. Defaults to ${DEFAULT_LOG_TYPE}.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const logType = args.logType ?? DEFAULT_LOG_TYPE
      const lookbackMinutes = config.lookbackMinutes ?? 30
      const sql = buildListServicesSql({
        logType,
        schema,
        table,
        timestampCol,
        lookbackMinutes,
        limit: config.listServicesLimit ?? 200,
      })

      try {
        const rows = await ctx.greptimedb.query(sql)
        const services = rows
          .map(row => String(row['workload_name'] ?? '').trim())
          .filter(serviceName => serviceName.length > 0)
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: liveEnv(), log_type: logType, sql, services },
          summary: `env=${liveEnv()} log_type=${logType} 近 ${lookbackMinutes} 分钟发现 ${services.length} 个 workload_name`,
          confidence: 0.9,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: liveEnv(), log_type: logType, sql, error: errorMessage(error) },
          summary: `查询失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      }
    },
  }))
}
