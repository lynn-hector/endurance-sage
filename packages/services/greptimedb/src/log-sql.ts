/**
 * Read-only SQL builder for the k8s container-log table in GreptimeDB.
 *
 * Verbatim port of `build_sql` / `build_list_services_sql` / `_parse_filter`
 * from the original `skills/log-analyzer/scripts/fetch_logs.py`. The golden
 * tests in `tests/sql.test.ts` pin the generated SQL to the examples in the
 * original `SKILL.md`, character for character.
 *
 * One deliberate deviation: the Python original collapsed repeated operator
 * whitespace with `str.replace("  ", " ")` (a pairwise collapse); this port
 * uses `/\s+/g → ' '`, which normalizes any whitespace run. The two differ
 * only on inputs with ≥3 consecutive spaces inside `IS NOT NULL` / `NOT LIKE`,
 * where the Python output kept stray spaces — a quirk, not a contract.
 *
 * @module @dsh-sentry/service-greptimedb/log-sql
 */

/** Known columns of `public.k8s_logs`; the filter DSL whitelist (injection guard). */
export const ALLOWED_LOG_FIELDS = [
  'greptime_timestamp',
  'log_type',
  'workload_name',
  'message',
  'not_expand',
  'trace_id',
  'tenant',
  'caller',
  'level',
] as const

const ALLOWED = new Set<string>(ALLOWED_LOG_FIELDS)

/** Escape single quotes in a SQL string literal. */
export function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

function sortedAllowed(): string {
  return `[${[...ALLOWED].sort().map(field => `'${field}'`).join(', ')}]`
}

function assertAllowedField(field: string): void {
  if (!ALLOWED.has(field)) {
    throw new Error(`未知字段 '${field}'，允许字段: ${sortedAllowed()}`)
  }
}

/** Strip one layer of matching outer quotes users may wrap values in. */
function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse one filter-DSL expression into a SQL WHERE fragment.
 *
 * Supported grammar (field must be whitelisted):
 * - `field=value`           → `"field" = 'value'`
 * - `field!=value`          → `"field" != 'value'`
 * - `field LIKE value`      → `"field" LIKE 'value'` (`%` in value is kept)
 * - `field NOT LIKE value`  → `"field" NOT LIKE 'value'`
 * - `field IS NULL`         → `"field" IS NULL`
 * - `field IS NOT NULL`     → `"field" IS NOT NULL`
 */
export function parseLogFilter(expr: string): string {
  const trimmed = expr.trim()
  if (trimmed.length === 0) throw new Error('filter 表达式不能为空')

  const nullMatch = /^(\w+)\s+IS\s+(NOT\s+NULL|NULL)$/i.exec(trimmed)
  if (nullMatch) {
    const field = nullMatch[1]!.toLowerCase()
    assertAllowedField(field)
    const op = nullMatch[2]!.toUpperCase().replace(/\s+/g, ' ')
    return `"${field}" IS ${op}`
  }

  const likeMatch = /^(\w+)\s+(NOT\s+LIKE|LIKE)\s+(.+)$/i.exec(trimmed)
  if (likeMatch) {
    const field = likeMatch[1]!.toLowerCase()
    assertAllowedField(field)
    const op = likeMatch[2]!.toUpperCase().replace(/\s+/g, ' ')
    const value = stripOuterQuotes(likeMatch[3]!.trim())
    return `"${field}" ${op} '${escapeSqlLiteral(value)}'`
  }

  const eqMatch = /^(\w+)\s*(=|!=)\s*(.+)$/.exec(trimmed)
  if (eqMatch) {
    const field = eqMatch[1]!.toLowerCase()
    assertAllowedField(field)
    const op = eqMatch[2]!
    const value = stripOuterQuotes(eqMatch[3]!.trim())
    return `"${field}" ${op} '${escapeSqlLiteral(value)}'`
  }

  throw new Error(
    `无法解析 filter 表达式 '${expr}'，`
    + '支持格式: field=value, field!=value, '
    + 'field LIKE value, field NOT LIKE value, '
    + 'field IS NULL, field IS NOT NULL',
  )
}

/** Options for {@link buildLogQuerySql}. */
export interface LogQuerySqlOptions {
  /** Workload names; one becomes `=`, several become `IN (...)`, none adds no filter. */
  services?: string[]
  /** ISO8601 lower bound (inclusive) on the timestamp column. */
  start: string
  /** ISO8601 upper bound (inclusive) on the timestamp column. */
  end: string
  /** `message LIKE %kw%` shortcuts; OR-ed inside one AND-ed clause. */
  keywords?: string[]
  limit: number
  logType: string
  schema: string
  table: string
  timestampCol: string
  /** AND-connected filter DSL expressions. */
  filters?: string[]
  /** Filter DSL expressions OR-ed into one block, AND-ed as a whole. */
  filterOr?: string[]
}

/**
 * Build the read-only log-query SELECT. Clause order is contractual (golden
 * tests pin it): base conditions, services, keywords, AND filters, OR block.
 */
export function buildLogQuerySql(options: LogQuerySqlOptions): string {
  const { start, end, limit, logType, schema, table, timestampCol } = options
  const where: string[] = [
    `"log_type" = '${escapeSqlLiteral(logType)}'`,
    `"${timestampCol}" >= '${escapeSqlLiteral(start)}'`,
    `"${timestampCol}" <= '${escapeSqlLiteral(end)}'`,
  ]

  const services = options.services?.filter(service => service.length > 0)
  if (services !== undefined && services.length > 0) {
    if (services.length === 1) {
      where.push(`"workload_name" = '${escapeSqlLiteral(services[0]!)}'`)
    } else {
      const inValues = services.map(service => `'${escapeSqlLiteral(service)}'`).join(', ')
      where.push(`"workload_name" IN (${inValues})`)
    }
  }

  const keywords = options.keywords?.map(keyword => keyword.trim()).filter(keyword => keyword.length > 0)
  if (keywords !== undefined && keywords.length > 0) {
    const likeClauses = keywords.map(keyword => `"message" LIKE '%${escapeSqlLiteral(keyword)}%'`)
    where.push(`(${likeClauses.join(' OR ')})`)
  }

  for (const filter of options.filters ?? []) {
    where.push(parseLogFilter(filter))
  }

  if (options.filterOr !== undefined && options.filterOr.length > 0) {
    const orClauses = options.filterOr.map(filter => parseLogFilter(filter))
    where.push(`(${orClauses.join(' OR ')})`)
  }

  return (
    `SELECT * FROM "${escapeSqlLiteral(schema)}"."${escapeSqlLiteral(table)}" `
    + `WHERE ${where.join(' AND ')} `
    + `ORDER BY "${timestampCol}" DESC `
    + `LIMIT ${Math.trunc(limit)}`
  )
}

/** Options for {@link buildListServicesSql}. */
export interface ListServicesSqlOptions {
  logType: string
  schema: string
  table: string
  timestampCol: string
  /** Lookback window in minutes; defaults to 30. */
  lookbackMinutes?: number
  /** Row cap; defaults to 200. */
  limit?: number
}

/** Query every `workload_name` with logs in the recent lookback window. */
export function buildListServicesSql(options: ListServicesSqlOptions): string {
  const { logType, schema, table, timestampCol } = options
  const lookbackMinutes = Math.trunc(options.lookbackMinutes ?? 30)
  const limit = Math.trunc(options.limit ?? 200)
  return (
    `SELECT DISTINCT "workload_name" `
    + `FROM "${escapeSqlLiteral(schema)}"."${escapeSqlLiteral(table)}" `
    + `WHERE "workload_name" IS NOT NULL `
    + `AND "${timestampCol}" >= NOW() - INTERVAL '${lookbackMinutes} minutes' `
    + `AND "log_type" = '${escapeSqlLiteral(logType)}' `
    + `ORDER BY "workload_name" `
    + `LIMIT ${limit}`
  )
}
