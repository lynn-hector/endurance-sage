/**
 * DB inspector tool: execute read-only SQL through the dbx platform and
 * return the first result set in the unified evidence envelope.
 *
 * Port of the original `skills/db-inspector` (SKILL.md + scripts/inspect.py).
 * The CLI flags collapse into one JSON-Schema tool; the dbx platform
 * endpoint/password resolution (`_get_dbx_platform_config`, with its
 * db→redis datasource fallback) is gone — the shared `service-dbx` now owns
 * the platform connection, and this plugin only carries query defaults.
 *
 * Deliberate normalizations (recorded drift):
 * - the original `_build_evidence` returned bare evidence fields without the
 *   `{ evidence: ... }` envelope mandated by `templates/evidence-format.md`;
 *   this tool emits the standard envelope via `@dsh-sentry/evidence`;
 * - the original `--dry-run` printed raw non-evidence JSON; this tool returns
 *   an evidence envelope marked `dry_run: true`;
 * - the original crashed with RuntimeError on missing config; this tool
 *   returns an error evidence envelope (confidence 0) with the same wording.
 *
 * @module @dsh-sentry/tool-db-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv, liveAssemblyEntryConfig } from '@dsh-sentry/env-matrix'
import type {} from '@dsh-sentry/service-dbx'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-db-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'dbx']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
  /**
   * Default database name, from the original `db.database` / `db.schema`
   * config fields. Calls may override it per query.
   */
  database?: string
  /** Preferred postgres connection id (the original `db.connection_id`). */
  connectionId?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
  database: z.string().description('默认数据库名（原 db.database / db.schema）'),
  connectionId: z.string().description('优先使用的 postgres 连接 ID（原 db.connection_id）'),
})

const SOURCE = 'db-inspector'
const TYPE = 'db'
const CONN_TYPE = 'postgres'
const DEFAULT_MAX_ROWS = 100

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const DB_INSPECTOR_ENTRY_ID = 'sentry-tool-db-inspector'

/** Register the SQL query tool. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'
  const liveDatabase = (): string | undefined => {
    const fromAssembly = liveAssemblyEntryConfig(DB_INSPECTOR_ENTRY_ID)?.database
    return typeof fromAssembly === 'string' && fromAssembly.length > 0 ? fromAssembly : undefined
  }
  const refs = (): string[] => [`dbx:${ctx.dbx.endpoint}`, `env:${liveEnv()}:db`]

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
    async execute(args, _exec) {
      // Original `_get_database`: CLI param wins, then db.database/db.schema.
      const database = args.database ?? liveDatabase() ?? config.database ?? ''
      if (database.length === 0) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: `config/${liveEnv()}.yml 中 db.database 或 db.schema 缺失，也可通过 database 参数指定`,
          summary: '缺少数据库名配置',
          refs: refs(),
        }) as unknown as JsonValue
      }

      const maxRows = args.maxRows ?? DEFAULT_MAX_ROWS
      const preferredId = config.connectionId

      if (args.dryRun === true) {
        // Deviation (module doc): evidence envelope instead of raw JSON.
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            dry_run: true,
            url: `${ctx.dbx.endpoint}/api/query/execute-multi`,
            headers: { cookie: 'dbx_session=...', 'content-type': 'application/json' },
            body: {
              connectionId: preferredId ?? '(auto-discover)',
              database,
              sql: args.sql,
              maxRows,
              fetchSize: maxRows,
            },
          },
          summary: `[dry-run] env=${liveEnv()} 构造 SQL 查询请求，未发送。`,
          confidence: 1.0,
          refs: refs(),
        }) as unknown as JsonValue
      }

      try {
        const discovered = await ctx.dbx.discoverConnection(CONN_TYPE, preferredId)
        // Original warmed the database-list cache here without validating the
        // chosen database ("显式指定数据库时只做缓存，不强制验证存在性").
        await ctx.dbx.listDatabases(discovered.id)

        const { value: results, connectionId } = await ctx.dbx.runWithFallback(
          CONN_TYPE,
          discovered.id,
          preferredId,
          id => ctx.dbx.executeQuery(id, database, args.sql, { maxRows }),
        )

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
            env: liveEnv(),
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
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `SQL 查询失败: ${errorMessage(error)}`,
          refs: refs(),
        }) as unknown as JsonValue
      }
    },
  }))
}
