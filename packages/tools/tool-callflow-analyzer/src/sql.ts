/**
 * Read-only SQL builder for the SIP call-flow table (`hep_1`) in GreptimeDB.
 *
 * Mirrors `tool-log-analyzer/sql.ts` minus the filter DSL: this tool has
 * exactly one query shape — dual-key match (`call_id = ? OR trace_id = ?`,
 * the hep_1 dashboard's behavior) inside a time window, ascending by
 * timestamp. No user-supplied column names means no whitelist is needed;
 * values go through {@link escapeSqlLiteral} only.
 *
 * @module @dsh-sentry/tool-callflow-analyzer/sql
 */

/** Escape single quotes in a SQL string literal. */
export function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/** Options for {@link buildCallFlowSql}. */
export interface CallFlowSqlOptions {
  /** Call identifier; matched against both `call_id` and `trace_id`. */
  callId: string
  /** ISO8601 lower bound (inclusive) on the timestamp column. */
  start: string
  /** ISO8601 upper bound (inclusive) on the timestamp column. */
  end: string
  limit: number
  schema: string
  table: string
  timestampCol: string
}

/**
 * Build the read-only call-flow SELECT. Clause order is contractual (golden
 * tests pin it): dual-key match, time range, ascending order, limit.
 */
export function buildCallFlowSql(options: CallFlowSqlOptions): string {
  const { callId, start, end, limit, schema, table, timestampCol } = options
  const id = escapeSqlLiteral(callId.trim())
  return (
    `SELECT * FROM "${escapeSqlLiteral(schema)}"."${escapeSqlLiteral(table)}" `
    + `WHERE ("call_id" = '${id}' OR "trace_id" = '${id}') `
    + `AND "${timestampCol}" >= '${escapeSqlLiteral(start)}' `
    + `AND "${timestampCol}" <= '${escapeSqlLiteral(end)}' `
    + `ORDER BY "${timestampCol}" ASC `
    + `LIMIT ${Math.trunc(limit)}`
  )
}
