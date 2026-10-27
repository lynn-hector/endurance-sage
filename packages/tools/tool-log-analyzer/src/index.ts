/**
 * Log analyzer Tool Consumer.
 *
 * Depends only on the LogStore Definition and the Session environment
 * Provider router. Log SQL, table names, schema names, field whitelist,
 * endpoint and credentials belong to the Provider; the Provider for one
 * call is the calling session's bound environment, leased through
 * `envProviders`. The tool keeps the two model-facing entrypoints
 * (`sentry_query_logs` and `sentry_list_log_services`), the filter DSL
 * syntax, evidence envelope and the pure anomaly-pattern extraction.
 *
 * @module @dsh-sentry/tool-log-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { K8S_LOG_FILTER_FIELDS, type LogStore } from '@dsh-sentry/log-store'
import type {} from '@dsh-sentry/service-env-provider'
import { extractLogPatterns } from './patterns.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-log-analyzer'

/** The capability slots this plugin registers into. */
export const inject = ['tools', 'envProviders']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** How many aggregated patterns a query returns. Defaults to 5. */
  patternsTopN?: number
}

export const Config: z<Config> = z.object({
  patternsTopN: z.number().step(1).min(1).default(5).description('聚合模式返回个数'),
})

const SOURCE = 'log-analyzer'
const TYPE = 'log'
const DEFAULT_LIMIT = 1000
const DEFAULT_LOG_TYPE = 'go'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The store, env label and lease one call fixed at its start. */
interface CallProvider {
  env: string
  store: LogStore
  release: () => Promise<void>
}

function filterDslGuide(fields: readonly string[]): string {
  return '过滤 DSL：`field=value` / `field!=value` / `field LIKE value` / `field NOT LIKE value` / '
    + '`field IS NULL` / `field IS NOT NULL`。LIKE 的 value 不自动加 `%`。'
    + `允许字段: ${[...fields].sort().join(', ')}`
}

/** Register the two log tools against the backend-neutral seam. */
export function apply(ctx: Context, config: Config): void {
  // The DSL whitelist is registration-time static: every environment renders
  // the same k8s_logs schema, and the shared contract lives on the Definition.
  const guide = filterDslGuide(K8S_LOG_FILTER_FIELDS)

  // The Provider is the calling session's bound environment: env, backend
  // identity and lease are fixed per call before the first backend await.
  const routeStore = async (exec: ToolRunContext): Promise<CallProvider> => {
    const lease = await ctx.envProviders.forCall(exec)
    return { env: lease.env, store: lease.require('logStore'), release: lease.release }
  }

  ctx.tools.register(defineTool({
    name: 'sentry_query_logs',
    description:
      'Query k8s container logs and extract recurring anomaly patterns. '
      + 'Read-only. Prefer a tight time window (5–15 minutes around the symptom). '
      + 'When unsure which workloads produce logs, call sentry_list_log_services first. '
      + guide,
    parameters: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workload names. Omit to query all services — expensive.',
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
        description: `AND-connected filter DSL expressions. ${guide}`,
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
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeStore(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store } = call
        const backendRef = store.backendRef
        const refs = (): string[] => [backendRef, `env:${env}:logs`]
        const logType = args.logType ?? DEFAULT_LOG_TYPE
        const limit = args.limit ?? DEFAULT_LIMIT
        const services = args.services?.map(service => service.trim()).filter(service => service.length > 0)
        const serviceLabel = services?.join(',') ?? ''

        const { records: logs, timestampField } = await store.queryLogs({
          ...services !== undefined && services.length > 0 ? { services } : {},
          start: args.start,
          end: args.end,
          ...args.keywords !== undefined ? { keywords: args.keywords } : {},
          limit,
          logType,
          ...args.filters !== undefined && args.filters.length > 0 ? { filters: args.filters } : {},
          ...args.filterOr !== undefined && args.filterOr.length > 0 ? { filterOr: args.filterOr } : {},
        })
        const patterns = extractLogPatterns(logs, {
          topN: config.patternsTopN ?? 5,
          timestampCol: timestampField,
        })
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: backendRef,
            service: serviceLabel,
            start: args.start,
            end: args.end,
            logs,
            patterns,
          },
          summary:
            `env=${env} service=${serviceLabel} 时间窗 [${args.start}, ${args.end}] `
            + `返回 ${logs.length} 条日志，提取 ${patterns.length} 个模式。`,
          confidence: logs.length > 0 ? 0.8 : 0.4,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        const backendRef = call?.store.backendRef
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `查询失败: ${errorMessage(error)}`,
          refs: backendRef === undefined ? [] : [backendRef, `env:${call?.env ?? 'unknown'}:logs`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
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
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeStore(exec)
        const { env, store } = call
        const backendRef = store.backendRef
        const refs = (): string[] => [backendRef, `env:${env}:logs`]
        const logType = args.logType ?? DEFAULT_LOG_TYPE

        const services = await store.listLogServices({ logType })
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env, backend_ref: backendRef, log_type: logType, services },
          summary: `env=${env} log_type=${logType} 发现 ${services.length} 个 workload_name`,
          confidence: 0.9,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        const backendRef = call?.store.backendRef
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `查询失败: ${errorMessage(error)}`,
          refs: backendRef === undefined ? [] : [backendRef, `env:${call?.env ?? 'unknown'}:logs`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
      }
    },
  }))
}
