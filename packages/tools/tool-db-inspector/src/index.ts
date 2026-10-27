/**
 * DB inspector Tool Consumer.
 *
 * Depends only on the DbStore Definition. dbx connection discovery, platform
 * requests, session refresh and the preferred-connection configuration
 * belong to the Provider. The tool keeps the model-facing entrypoint
 * (`sentry_query_db`), the query defaults that are genuine caller intent
 * (the default `database`), the evidence envelope and the first-result-set
 * surfacing.
 *
 * Port of the original `skills/db-inspector` (SKILL.md + scripts/inspect.py).
 *
 * Deliberate normalizations (recorded drift):
 * - the original `_build_evidence` returned bare evidence fields without the
 *   `{ evidence: ... }` envelope mandated by `templates/evidence-format.md`;
 *   this tool emits the standard envelope via `@dsh-sentry/evidence`;
 * - the original `--dry-run` printed the raw HTTP request (URL, cookie
 *   header, execute-multi body); this tool returns an evidence envelope
 *   marked `dry_run: true` with the backend-neutral request only (sql +
 *   database + maxRows + backend_ref) — wire details no longer cross the
 *   seam;
 * - the original crashed with RuntimeError on missing config; this tool
 *   returns an error evidence envelope (confidence 0) with the same wording.
 *
 * @module @dsh-sentry/tool-db-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type { DbStore } from '@dsh-sentry/db-store'
import type {} from '@dsh-sentry/db-store'
import type {} from '@dsh-sentry/service-env-provider'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-db-inspector'

/** The capability slots this plugin registers into. */
export const inject = ['tools', 'dbStore']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
  /**
   * Default database name, from the original `db.database` / `db.schema`
   * config fields. Calls may override it per query. This is caller intent
   * (which logical database to inspect), not Provider configuration.
   */
  database?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
  database: z.string().description('默认数据库名（原 db.database / db.schema）'),
})

const SOURCE = 'db-inspector'
const TYPE = 'db'
const DEFAULT_MAX_ROWS = 100

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The store, env label and lease one call fixed at its start. */
interface CallProvider {
  env: string
  store: DbStore
  release: () => Promise<void>
}

/** Register the SQL query tool against the backend-neutral seam. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

  // Session-routed hosts resolve the Provider through the calling session's
  // binding; legacy hosts keep the global store and assembly env label.
  const routeStore = async (exec: ToolRunContext): Promise<CallProvider> => {
    const envProviders = ctx.get('envProviders')
    if (envProviders !== undefined) {
      const lease = await envProviders.forCall(exec)
      return { env: lease.env, store: lease.require('dbStore'), release: lease.release }
    }
    return { env: liveEnv(), store: ctx.dbStore, release: async () => {} }
  }

  ctx.tools.register(defineTool({
    name: 'sentry_query_db',
    description:
      'Execute a read-only SQL query through the dbx platform (postgres connection) and return rows, '
      + 'columns, and execution stats. Read-only: never issue write/DDL statements. '
      + 'Session and connection discovery are handled automatically with refresh-and-retry fallback.',
    parameters: {
      sql: { type: 'string', required: true, description: 'The SQL statement to execute (read-only).' },
      database: { type: 'string', description: 'Database name. Defaults to the plugin configuration.' },
      maxRows: { type: 'number', default: DEFAULT_MAX_ROWS, description: `Max rows to return. Defaults to ${DEFAULT_MAX_ROWS}.` },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
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
        const refs = (): string[] => [backendRef, `env:${env}:db`]

        // Original `_get_database`: CLI param wins, then db.database/db.schema.
        const database = args.database ?? config.database ?? ''
        if (database.length === 0) {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE,
            error: `config/${env}.yml 中 db.database 或 db.schema 缺失，也可通过 database 参数指定`,
            summary: '缺少数据库名配置',
            refs: refs(),
          }) as unknown as JsonValue
        }

        const maxRows = args.maxRows ?? DEFAULT_MAX_ROWS

        if (args.dryRun === true) {
          // Deviation (module doc): neutral evidence envelope instead of the raw
          // HTTP request the script printed.
          return buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: {
              env,
              dry_run: true,
              backend_ref: backendRef,
              sql: args.sql,
              database,
              maxRows,
            },
            summary: `[dry-run] env=${env} 构造 SQL 查询请求，未发送。`,
            confidence: 1.0,
            refs: refs(),
          }) as unknown as JsonValue
        }

        const { connectionId, results } = await store.querySql({ sql: args.sql, database, maxRows })

        // Original `_build_evidence`: only the first result set is surfaced.
        const result = (results[0] ?? {}) as Record<string, unknown>
        const columns = (result['columns'] ?? []) as unknown[]
        const columnTypes = (result['column_types'] ?? []) as unknown[]
        const rows = (result['rows'] ?? []) as unknown[]
        const executionTimeMs = result['execution_time_ms']
        const truncated = result['truncated'] ?? false
        const affectedRows = result['affected_rows'] ?? 0
        const rowCount = rows.length

        let summary = `SQL 查询完成，返回 ${rowCount} 行`
        if (executionTimeMs !== undefined && executionTimeMs !== null) {
          summary += `，执行 ${String(executionTimeMs)} ms`
        }
        if (truncated === true) summary += '，结果已被截断'

        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: backendRef,
            sql: args.sql,
            database,
            connection_id: connectionId,
            columns,
            column_types: columnTypes,
            rows,
            row_count: rowCount,
            execution_time_ms: executionTimeMs ?? null,
            truncated,
            affected_rows: affectedRows,
            raw_response: results,
          },
          summary,
          confidence: results.length > 0 ? 0.95 : 0.5,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        const backendRef = call?.store.backendRef
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `SQL 查询失败: ${errorMessage(error)}`,
          refs: backendRef === undefined ? [] : [backendRef, `env:${call?.env ?? 'unknown'}:db`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
      }
    },
  }))
}
