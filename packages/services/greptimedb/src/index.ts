/**
 * GreptimeDB HTTP `/v1/sql` client as a Cordis service.
 *
 * Port of the transport half of the original
 * `skills/log-analyzer/scripts/fetch_logs.py` (`query_greptimedb` +
 * `parse_rows`): POST form-encoded SQL with HTTP Basic auth, parse the
 * column-schema/rows response into records. Read-only by usage — the service
 * never issues anything but caller-supplied SELECT statements.
 *
 * Differences from the script era: credentials resolve per query through the
 * ambient credential plane (`@dsh-sentry/datasource`), so a hot-reloaded
 * credential store takes effect without restarting; `fetch` keep-alive gives
 * connection reuse the per-invocation script never had.
 *
 * @module @dsh-sentry/service-greptimedb
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  credentialRefField,
  endpointField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** GreptimeDB HTTP base, e.g. `https://greptimedb.example.com`. */
  endpoint: string
  /** Database passed as the `db` query parameter. Defaults to `public`. */
  database?: string
  /** Credential reference for the Basic-auth username, e.g. `GREPTIMEDB_PRODUCTION_USERNAME`. */
  usernameRef?: string
  /** Credential reference for the Basic-auth password. */
  passwordRef?: string
  /** Literal username fallback when no reference is configured. Discouraged in composition files. */
  username?: string
  /** Literal password fallback when no reference is configured. Discouraged in composition files. */
  password?: string
  /** Per-query timeout in milliseconds. Defaults to 30000 (the original script's query timeout). */
  timeoutMs?: number
}

export class GreptimeDbService extends Service {
  static Config: z<Config> = z.object({
    endpoint: endpointField('GreptimeDB HTTP 地址，如 https://greptimedb.example.com'),
    database: z.string().default('public').description('SQL 接口的 db 查询参数'),
    usernameRef: credentialRefField('Basic 认证用户名的凭据引用，如 GREPTIMEDB_PRODUCTION_USERNAME'),
    passwordRef: credentialRefField('Basic 认证密码的凭据引用'),
    username: secretField('内联用户名（credential ref 优先；不推荐写在组合文件）'),
    password: secretField('内联密码（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
  })

  private readonly endpoint: string
  private readonly database: string
  private readonly timeoutMs: number

  constructor(ctx: Context, config: Config = { endpoint: '' }) {
    super(ctx, 'greptimedb')
    // The schema already defaulted optional fields under the Loader; the ??
    // narrows the type for direct (non-Loader) construction in tests.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.database = config.database ?? 'public'
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.config = config
  }

  private readonly config: Config

  /** Resolve Basic-auth credentials: references win over literal fallbacks. */
  private async credentials(): Promise<{ username: string; password: string }> {
    let username: string | undefined
    let password: string | undefined
    if (this.config.usernameRef !== undefined) {
      username = await resolveCredential(this.ctx, this.config.usernameRef)
    }
    if (this.config.passwordRef !== undefined) {
      password = await resolveCredential(this.ctx, this.config.passwordRef)
    }
    username ??= this.config.username
    password ??= this.config.password
    if (this.endpoint.length === 0 || !username || !password) {
      throw new Error('endpoint 或凭据缺失，请检查插件配置和凭据注入')
    }
    return { username, password }
  }

  /**
   * Execute a read-only SQL statement and return parsed rows.
   * @param sql - caller-supplied SELECT statement.
   * @param options.database - overrides the configured database for one query.
   * @returns row objects keyed by column name.
   */
  async query(sql: string, options?: { database?: string }): Promise<Record<string, unknown>[]> {
    const { username, password } = await this.credentials()
    const database = options?.database ?? this.database
    const url = `${this.endpoint}/v1/sql?db=${encodeURIComponent(database)}`
    const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')

    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `sql=${encodeURIComponent(sql)}`,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`GreptimeDB 连接失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`GreptimeDB HTTP ${resp.status}: ${detail}`)
    }

    let body: unknown
    try {
      body = await resp.json()
    } catch (cause) {
      throw new Error(`GreptimeDB 响应不是合法 JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return parseGreptimeRows(body)
  }
}

/**
 * Defensive normalization for timestamp columns: whatever unit the backend
 * returns (nanoseconds is the documented native form; digit-strings and
 * millisecond values also occur), map integral epoch values to ISO8601 UTC
 * and leave everything else (date-shaped strings, null, negatives,
 * unrecognizable) untouched. Formatted by hand — `Date` would truncate to
 * milliseconds.
 */
export function normalizeGreptimeTimestamp(value: unknown): unknown {
  // Digit-strings go through BigInt directly: big nanosecond values exceed
  // Number.MAX_SAFE_INTEGER, so a Number round-trip would destroy exactly the
  // sub-millisecond digits this function exists to preserve. Numbers are
  // already lossy at the literal; Math.round is the best available.
  let total: bigint
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return value
    total = BigInt(Math.round(value))
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const digits = value.trim()
    if (digits.startsWith('-')) return value
    total = BigInt(digits)
  } else {
    return value
  }
  let nanosPerUnit: bigint
  let fracDigits: number
  if (total > 100000000000000000n) {
    nanosPerUnit = 1n
    fracDigits = 9
  } else if (total > 100000000000000n) {
    nanosPerUnit = 1000n
    fracDigits = 6
  } else if (total > 100000000000n) {
    nanosPerUnit = 1000000n
    fracDigits = 3
  } else {
    nanosPerUnit = 1000000000n
    fracDigits = 0
  }
  const totalNanos = total * nanosPerUnit
  const seconds = totalNanos / 1000000000n
  const ms = Number(seconds) * 1000
  // 超出 Date 表示范围的怪值（误摄入的 ID、垃圾数字串）原样透传：
  // 归一化的目的是排版，不该让一列脏数据炸掉整条查询
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return value
  const nanos = totalNanos % 1000000000n
  const base = new Date(ms).toISOString().replace(/\.\d{3}Z$/, '')
  return fracDigits === 0 ? `${base}Z` : `${base}.${nanos.toString().padStart(9, '0').slice(0, fracDigits)}Z`
}

/**
 * Parse the GreptimeDB `/v1/sql` response into row objects.
 *
 * Expected shape:
 * ```json
 * { "output": [ { "records": {
 *   "schema": { "column_schemas": [ { "name": "col1", "datatype": "..." } ] },
 *   "rows": [ [ "v1" ] ]
 * } } ] }
 * ```
 *
 * Columns whose datatype (keyed `datatype` or `data_type`) mentions
 * "timestamp" case-insensitively are routed through
 * {@link normalizeGreptimeTimestamp}; everything else passes through as-is.
 */
export function parseGreptimeRows(body: unknown): Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null) return []
  const output = (body as { output?: unknown }).output
  if (!Array.isArray(output) || output.length === 0) return []
  const first = output[0] as { records?: unknown }
  const records = (typeof first === 'object' && first !== null ? first.records : undefined) as
    | { schema?: { column_schemas?: { name?: string; datatype?: unknown; data_type?: unknown }[] }; rows?: unknown }
    | undefined
  if (typeof records !== 'object' || records === null) return []
  const columnSchemas = records.schema?.column_schemas ?? []
  const colNames = columnSchemas.map((col, i) => col.name ?? `col_${i}`)
  const timestampCols = new Set<number>()
  for (const [i, col] of columnSchemas.entries()) {
    const datatype = col.datatype ?? col.data_type
    if (typeof datatype === 'string' && datatype.toLowerCase().includes('timestamp')) timestampCols.add(i)
  }
  const rawRows = Array.isArray(records.rows) ? records.rows : []
  const parsed: Record<string, unknown>[] = []
  for (const row of rawRows) {
    if (!Array.isArray(row)) continue
    const record: Record<string, unknown> = {}
    for (const [i, name] of colNames.entries()) {
      const cell = i < row.length ? row[i] : null
      record[name] = timestampCols.has(i) ? normalizeGreptimeTimestamp(cell) : cell
    }
    parsed.push(record)
  }
  return parsed
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    greptimedb: GreptimeDbService
  }
}

export default GreptimeDbService
