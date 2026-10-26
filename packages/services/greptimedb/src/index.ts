/**
 * GreptimeDB Provider package for the log and call-flow seams.
 *
 * One shared transport owns the HTTP `/v1/sql` endpoint, connect-token/Basic
 * authentication, timeout and row parsing. It mounts two backend-neutral
 * Providers from `@dsh-sentry/log-store` and `@dsh-sentry/callflow-store`;
 * neither slot exposes generic SQL. Table names, schema names, timestamp
 * columns and field whitelists are Provider configuration.
 *
 * Port of the transport half of the original
 * `skills/log-analyzer/scripts/fetch_logs.py` (`query_greptimedb` +
 * `parse_rows`). Credentials resolve per query through the ambient credential
 * plane (`@dsh-sentry/datasource`), so a hot-reloaded credential store takes
 * effect without restarting.
 *
 * @module @dsh-sentry/service-greptimedb
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  credentialRefField,
  endpointField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'
import {
  CallflowStore,
  DEFAULT_CALLFLOW_LIMIT,
  DEFAULT_CALLFLOW_LOOKBACK_MS,
  summarizeCallFlow,
  type CallflowQueryRequest,
  type CallflowQueryResult,
} from '@dsh-sentry/callflow-store'
import { LogStore, type ListLogServicesRequest, type LogQueryRequest, type LogQueryResult } from '@dsh-sentry/log-store'

import { decryptConnectToken } from './connect-token.ts'
import { buildCallFlowSql } from './callflow-sql.ts'
import { ALLOWED_LOG_FIELDS, buildListServicesSql, buildLogQuerySql } from './log-sql.ts'

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
  /** Credential reference for a dashboard connect token (the bare base64url token, not the whole URL). */
  connectTokenRef?: string
  /** Literal connect token fallback when no reference is configured. Discouraged in composition files. */
  connectToken?: string
  /** Literal username fallback when no reference is configured. Discouraged in composition files. */
  username?: string
  /** Literal password fallback when no reference is configured. Discouraged in composition files. */
  password?: string
  /** Per-query timeout in milliseconds. Defaults to 30000 (the original script's query timeout). */
  timeoutMs?: number
  /** Log table schema. Defaults to `public`. */
  logSchema?: string
  /** Log table. Defaults to `k8s_logs`. */
  logTable?: string
  /** Log timestamp column. Defaults to `greptime_timestamp`. */
  logTimestampCol?: string
  /** Workload-discovery lookback window in minutes. Defaults to 30. */
  logLookbackMinutes?: number
  /** Workload-discovery row cap. Defaults to 200. */
  logListServicesLimit?: number
  /** Signaling table schema. Defaults to `public`. */
  callflowSchema?: string
  /** SIP signaling table. Defaults to `hep_1`. */
  callflowTable?: string
  /** Signaling timestamp column. Defaults to `greptime_timestamp`. */
  callflowTimestampCol?: string
}

const GreptimeDbServiceConfig: z<Config> = z.object({
  endpoint: endpointField('GreptimeDB HTTP 地址，如 https://greptimedb.example.com'),
  database: z.string().default('public').description('SQL 接口的 db 查询参数'),
  usernameRef: credentialRefField('Basic 认证用户名的凭据引用，如 GREPTIMEDB_PRODUCTION_USERNAME'),
  passwordRef: credentialRefField('Basic 认证密码的凭据引用'),
  connectTokenRef: credentialRefField('dashboard connect token（纯 token）的凭据引用，如 GREPTIMEDB_BR0_CONNECT_TOKEN'),
  connectToken: secretField('内联 connect token（credential ref 优先；不推荐写在组合文件）'),
  username: secretField('内联用户名（credential ref 优先；不推荐写在组合文件）'),
  password: secretField('内联密码（credential ref 优先；不推荐写在组合文件）'),
  timeoutMs: timeoutMsField(30_000),
  logSchema: z.string().default('public').description('日志表所在 schema'),
  logTable: z.string().default('k8s_logs').description('日志表名'),
  logTimestampCol: z.string().default('greptime_timestamp').description('日志时间范围过滤列'),
  logLookbackMinutes: z.number().step(1).min(1).default(30).description('日志服务发现的回看窗口（分钟）'),
  logListServicesLimit: z.number().step(1).min(1).default(200).description('日志服务发现的行数上限'),
  callflowSchema: z.string().default('public').description('信令表所在 schema'),
  callflowTable: z.string().default('hep_1').description('SIP 信令表名'),
  callflowTimestampCol: z.string().default('greptime_timestamp').description('信令时间范围过滤列'),
})

/** Shared HTTP transport and credential resolution for both GreptimeDB slots. */
export class GreptimeTransport {
  private readonly ctx: Context
  private readonly endpoint: string
  private readonly database: string
  private readonly timeoutMs: number
  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    this.ctx = ctx
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.database = config.database ?? 'public'
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.config = config
  }

  /** Non-secret identity shared by both Provider slots. */
  get backendRef(): string {
    return `greptimedb:${this.endpoint}/${this.database}`
  }

  /**
   * Resolve Basic-auth credentials. A configured connect token (reference
   * wins over the literal fallback) takes priority and must decrypt — a bad
   * token fails fast instead of silently falling back to username/password.
   * An empty-resolving token counts as unconfigured (falls through).
   */
  private async credentials(): Promise<{ username: string; password: string }> {
    let connectToken: string | undefined
    if (this.config.connectTokenRef !== undefined) {
      connectToken = await resolveCredential(this.ctx, this.config.connectTokenRef)
    }
    connectToken ??= this.config.connectToken
    if (connectToken !== undefined && connectToken.length > 0) {
      const payload = decryptConnectToken(connectToken)
      if (!payload.u || !payload.p) {
        throw new Error('connect token 解出的凭据缺 username/password，token 无效')
      }
      if (payload.h !== undefined && this.endpoint.length > 0
        && payload.h.replace(/\/+$/, '').toLowerCase() !== this.endpoint.toLowerCase()) {
        this.ctx.logger.warn(`connect token 内 host (${payload.h}) 与配置 endpoint (${this.endpoint}) 不一致，以配置为准`)
      }
      return { username: payload.u, password: payload.p }
    }
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
   * Execute one Provider-built read-only SQL statement and return parsed rows.
   * This method is package-internal plumbing; Consumers never see it.
   */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const { username, password } = await this.credentials()
    const url = `${this.endpoint}/v1/sql?db=${encodeURIComponent(this.database)}`
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

/** Construction options for the log Provider. */
export interface GreptimeLogStoreOptions {
  transport: GreptimeTransport
  schema?: string
  table?: string
  timestampCol?: string
  lookbackMinutes?: number
  listServicesLimit?: number
}

/** GreptimeDB implementation of the backend-neutral log seam. */
export class GreptimeLogStore extends LogStore {
  private readonly transport: GreptimeTransport
  private readonly schema: string
  private readonly table: string
  private readonly timestampCol: string
  private readonly lookbackMinutes: number
  private readonly listServicesLimit: number

  constructor(ctx: Context, options: GreptimeLogStoreOptions) {
    super(ctx)
    this.transport = options.transport
    this.schema = options.schema ?? 'public'
    this.table = options.table ?? 'k8s_logs'
    this.timestampCol = options.timestampCol ?? 'greptime_timestamp'
    this.lookbackMinutes = options.lookbackMinutes ?? 30
    this.listServicesLimit = options.listServicesLimit ?? 200
  }

  override get backendRef(): string {
    return this.transport.backendRef
  }

  override get logFilterFields(): readonly string[] {
    return ALLOWED_LOG_FIELDS
  }

  override async queryLogs(request: LogQueryRequest): Promise<LogQueryResult> {
    const services = request.services
      ?.map(service => service.trim())
      .filter(service => service.length > 0)
    const logType = request.logType ?? 'go'
    const limit = request.limit ?? 1000
    const sql = buildLogQuerySql({
      ...services !== undefined && services.length > 0 ? { services } : {},
      start: request.start,
      end: request.end,
      ...request.keywords !== undefined && request.keywords.length > 0 ? { keywords: request.keywords } : {},
      limit,
      logType,
      schema: this.schema,
      table: this.table,
      timestampCol: this.timestampCol,
      ...request.filters !== undefined && request.filters.length > 0 ? { filters: request.filters } : {},
      ...request.filterOr !== undefined && request.filterOr.length > 0 ? { filterOr: request.filterOr } : {},
    })
    const records = await this.transport.query(sql)
    return { records, timestampField: this.timestampCol }
  }

  override async listLogServices(request: ListLogServicesRequest): Promise<string[]> {
    const sql = buildListServicesSql({
      logType: request.logType ?? 'go',
      schema: this.schema,
      table: this.table,
      timestampCol: this.timestampCol,
      lookbackMinutes: this.lookbackMinutes,
      limit: this.listServicesLimit,
    })
    const rows = await this.transport.query(sql)
    return rows
      .map(row => String(row['workload_name'] ?? '').trim())
      .filter(service => service.length > 0)
  }
}

/** Construction options for the call-flow Provider. */
export interface GreptimeCallflowStoreOptions {
  transport: GreptimeTransport
  schema?: string
  table?: string
  timestampCol?: string
}

/** GreptimeDB implementation of the backend-neutral call-flow seam. */
export class GreptimeCallflowStore extends CallflowStore {
  private readonly transport: GreptimeTransport
  private readonly schema: string
  private readonly table: string
  private readonly timestampCol: string

  constructor(ctx: Context, options: GreptimeCallflowStoreOptions) {
    super(ctx)
    this.transport = options.transport
    this.schema = options.schema ?? 'public'
    this.table = options.table ?? 'hep_1'
    this.timestampCol = options.timestampCol ?? 'greptime_timestamp'
  }

  override get backendRef(): string {
    return this.transport.backendRef
  }

  override async queryCallFlow(request: CallflowQueryRequest): Promise<CallflowQueryResult> {
    const callId = request.callId.trim()
    const start = request.start?.trim() || new Date(Date.now() - DEFAULT_CALLFLOW_LOOKBACK_MS).toISOString()
    const end = request.end?.trim() || new Date().toISOString()
    const limit = request.limit ?? DEFAULT_CALLFLOW_LIMIT
    const sql = buildCallFlowSql({
      callId,
      start,
      end,
      limit,
      schema: this.schema,
      table: this.table,
      timestampCol: this.timestampCol,
    })
    const messages = await this.transport.query(sql)
    return {
      start,
      end,
      limit,
      messages,
      summary: summarizeCallFlow(messages, { timestampCol: this.timestampCol }),
    }
  }
}

/**
 * Mount both GreptimeDB Providers over one shared transport. This function is
 * the plugin entry used by hosts and assembly files; the two exported classes
 * exist for direct construction in Provider tests.
 */
export async function GreptimeDbService(ctx: Context, config: Config): Promise<void> {
  const transport = new GreptimeTransport(ctx, config)
  await ctx.plugin(GreptimeLogStore, {
    transport,
    schema: config.logSchema,
    table: config.logTable,
    timestampCol: config.logTimestampCol,
    lookbackMinutes: config.logLookbackMinutes,
    listServicesLimit: config.logListServicesLimit,
  })
  await ctx.plugin(GreptimeCallflowStore, {
    transport,
    schema: config.callflowSchema,
    table: config.callflowTable,
    timestampCol: config.callflowTimestampCol,
  })
}

GreptimeDbService.Config = GreptimeDbServiceConfig

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

export default GreptimeDbService
