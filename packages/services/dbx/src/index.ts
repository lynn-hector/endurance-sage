/**
 * dbx platform client as a Cordis service.
 *
 * Port of `skills/lib/dbx.py` from endurance-sentry: dbx session
 * login/check/auto-refresh (`_check_auth` / `_login` / `ensure_session`),
 * connection auto-discovery (`_TYPE_HINTS` redis/postgres matching), database
 * list caching, and HTTP requests carrying the standard browser headers
 * (`_BASE_HEADERS`, kept verbatim — they exist to pass CORS/UA filtering).
 * It also absorbs `_query_value` from
 * `skills/redis-inspector/scripts/inspect.py` as {@link DbxService.redisGetValue},
 * so every dbx wire format lives in one package.
 *
 * Deliberate differences from the script era:
 * - State (session / discovered connections / database lists) was persisted
 *   to `~/.endurance-sentry/auth/{env}.json` via `auth_cache.py`. A
 *   long-lived Cordis process keeps it in instance memory with TTLs instead
 *   and re-logs-in after a restart; nothing touches disk. Expired entries are
 *   dropped lazily on read and by a periodic sweep whose timer is released
 *   through `ctx.effect()` (cordis v4 has no `dispose` event).
 * - The login password resolves per login through the ambient credential
 *   plane (`resolveCredential`), so a hot-reloaded credential store takes
 *   effect without restarting.
 * - Concurrent `ensureSession()` calls share one in-flight login
 *   (single-flight); the scripts were single-threaded and never needed it.
 * - `executeQuery` / `listDatabases` / `discoverConnection` / `redisGetValue`
 *   ensure the session internally instead of taking it as a parameter; the
 *   session threading of the scripts is an implementation detail here.
 * - Non-JSON success responses are wrapped in `dbx 响应不是合法 JSON: ...`
 *   (the script let the raw `json.JSONDecodeError` propagate); the
 *   `dbx HTTP {code}: ...` / `dbx 连接失败: ...` / login error wordings are
 *   kept verbatim.
 *
 * @module @dsh-sentry/service-dbx
 */

import { randomUUID } from 'node:crypto'
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
  /** dbx platform base URL, e.g. `https://dbx.cn-0.dev.novo-one.com`. */
  endpoint: string
  /**
   * Credential reference for the dbx login password (the original scripts
   * read `secrets_ref.password`, e.g. `REDIS_LOCAL_PASSWORD` /
   * `DBX_REDIS_PASSWORD`). Resolved at each login, never cached.
   */
  passwordRef?: string
  /** Literal password fallback when no reference is configured. Discouraged in composition files. */
  password?: string
  /** Per-request HTTP timeout in milliseconds. Defaults to 30000 (the script's `_DEFAULT_TIMEOUT = 30`). */
  timeoutMs?: number
  /**
   * Session cache TTL in milliseconds. Defaults to 24h, matching
   * `auth_cache._DEFAULT_TTL_HOURS`.
   */
  sessionTtlMs?: number
  /**
   * TTL for discovered connections and cached database lists. The scripts
   * cached these on disk with no expiry; in-memory caching needs a bound.
   * Defaults to 24h.
   */
  cacheTtlMs?: number
}

/**
 * Standard browser request headers, verbatim from `dbx.py._BASE_HEADERS`.
 * They exist so dbx's CORS/UA filtering treats the request as browser-originated.
 */
export const DBX_BASE_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9',
  priority: 'u=1, i',
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': 'macOS',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/150.0.0.0 Safari/537.36',
}

/** Connection-type matching hints, verbatim from `dbx.py._TYPE_HINTS`. */
export const DBX_TYPE_HINTS: Record<string, Record<string, string>> = {
  redis: { db_type: 'redis', driver_profile: 'redis', name: 'redis' },
  postgres: { db_type: 'postgres', driver_profile: 'postgres', name: 'postgres' },
}

const SESSION_COOKIE = 'dbx_session'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60_000
const DEFAULT_MAX_ROWS = 100
const DEFAULT_QUERY_TIMEOUT_SECS = 30

/** A discovered dbx connection: its activated id plus the config that produced it. */
export interface DbxConnection {
  id: string
  config: Record<string, unknown>
}

/** Options for the low-level {@link DbxService.request}. */
export interface DbxRequestOptions {
  method?: string
  /** Request body; callers pass a UTF-8 JSON string (the scripts passed encoded bytes). */
  body?: string
  /**
   * Query parameters. Joined verbatim as `k=v&k=v` with no URL encoding,
   * matching the original `"&".join(f"{k}={v}")` (dbx ids are URL-safe).
   */
  params?: Record<string, string>
  /** Extra headers merged over {@link DBX_BASE_HEADERS}; `origin`/`referer` are then forced by the service. */
  headers?: Record<string, string>
  /** dbx session value; sent as `cookie: dbx_session=<value>`. Omit for anonymous requests. */
  session?: string
  /** Per-call HTTP timeout override in milliseconds. */
  timeoutMs?: number
}

interface SessionEntry {
  value: string
  expiresAt: number
}

interface ConnectionEntry extends DbxConnection {
  expiresAt: number
}

interface DatabasesEntry {
  names: string[]
  expiresAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract a cookie value from `Set-Cookie` response headers.
 * Port of `dbx.py._extract_cookie`.
 */
export function extractCookie(response: Response, name: string): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') !== null ? [headers.get('set-cookie') as string] : [])
  for (const cookie of rawCookies) {
    if (!cookie.startsWith(`${name}=`)) continue
    const first = cookie.split(';')[0] as string
    return first.slice(first.indexOf('=') + 1)
  }
  return undefined
}

/**
 * Pick the target-type connection out of `/api/connection/list` results.
 * Port of `dbx.py._pick_connection`: exact `preferredId` match first, then
 * `db_type` / `driver_profile` hint equality, then a lowercase substring
 * match on `name`.
 */
export function pickDbxConnection(
  connections: Record<string, unknown>[],
  connType: string,
  preferredId?: string,
): Record<string, unknown> | undefined {
  const hints = DBX_TYPE_HINTS[connType] ?? {}

  if (preferredId) {
    for (const c of connections) {
      if (c['id'] === preferredId) return c
    }
  }

  for (const key of ['db_type', 'driver_profile']) {
    const target = hints[key]
    if (target) {
      for (const c of connections) {
        if (c[key] === target) return c
      }
    }
  }

  const nameHint = hints['name']
  if (nameHint) {
    for (const c of connections) {
      if (String(c['name'] ?? '').toLowerCase().includes(nameHint)) return c
    }
  }

  return undefined
}

/**
 * dbx platform client. All session/connection/database state is per-instance
 * in-memory cache with TTLs; restarting the process simply re-logs-in.
 */
export class DbxService extends Service {
  static Config: z<Config> = z.object({
    endpoint: endpointField('dbx 平台地址，如 https://dbx.cn-0.dev.novo-one.com'),
    passwordRef: credentialRefField('dbx 登录密码的凭据引用，如 REDIS_LOCAL_PASSWORD / DBX_REDIS_PASSWORD'),
    password: secretField('内联登录密码（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(DEFAULT_TIMEOUT_MS),
    sessionTtlMs: z.number().step(1).min(1).default(DEFAULT_SESSION_TTL_MS)
      .description('session 内存缓存 TTL（毫秒），默认 24 小时（对齐 auth_cache 默认过期）'),
    cacheTtlMs: z.number().step(1).min(1).default(DEFAULT_CACHE_TTL_MS)
      .description('连接发现与数据库列表的内存缓存 TTL（毫秒），默认 24 小时'),
  })

  /** Configured base URL with trailing slashes stripped (used in evidence refs). */
  readonly endpoint: string
  private readonly timeoutMs: number
  private readonly sessionTtlMs: number
  private readonly cacheTtlMs: number
  private readonly config: Config

  private sessionEntry: SessionEntry | undefined
  private readonly connectionCache = new Map<string, ConnectionEntry>()
  private readonly databaseCache = new Map<string, DatabasesEntry>()
  private loginPromise: Promise<string> | undefined

  constructor(ctx: Context, config: Config = { endpoint: '' }) {
    super(ctx, 'dbx')
    // The schema already defaulted optional fields under the Loader; the ??
    // narrows the type for direct (non-Loader) construction in tests.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.config = config

    // Expired cache entries are also dropped lazily on read; this sweep only
    // bounds the memory of entries that are never read again. The timer is
    // released with the owning fiber (cordis v4 has no 'dispose' event;
    // ctx.effect is the cleanup seam).
    ctx.effect(() => {
      const timer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS)
      timer.unref()
      return () => clearInterval(timer)
    }, 'dbx cache sweep')
  }

  /** Drop expired session/connection/database entries. */
  private sweepExpired(): void {
    const now = Date.now()
    if (this.sessionEntry !== undefined && this.sessionEntry.expiresAt <= now) {
      this.sessionEntry = undefined
    }
    for (const [key, entry] of this.connectionCache) {
      if (entry.expiresAt <= now) this.connectionCache.delete(key)
    }
    for (const [key, entry] of this.databaseCache) {
      if (entry.expiresAt <= now) this.databaseCache.delete(key)
    }
  }

  /** Resolve the dbx login password: reference wins over the literal fallback. */
  private async resolvePassword(): Promise<string> {
    let password: string | undefined
    if (this.config.passwordRef !== undefined) {
      password = await resolveCredential(this.ctx, this.config.passwordRef)
    }
    password ??= this.config.password
    if (this.endpoint.length === 0 || !password) {
      throw new Error('dbx endpoint 或登录密码缺失，请检查插件配置和凭据注入')
    }
    return password
  }

  /**
   * Low-level dbx request. Port of `dbx.py.dbx_request`: browser headers +
   * forced `origin`/`referer`, optional session cookie, verbatim query-string
   * join, JSON response parsing, and the original error wordings.
   */
  async request(path: string, options: DbxRequestOptions = {}): Promise<unknown> {
    const mergedHeaders: Record<string, string> = { ...DBX_BASE_HEADERS, ...options.headers }
    mergedHeaders['origin'] = this.endpoint
    mergedHeaders['referer'] = `${this.endpoint}/`
    if (options.session) mergedHeaders['cookie'] = `${SESSION_COOKIE}=${options.session}`

    let url = `${this.endpoint}${path}`
    if (options.params) {
      const query = Object.entries(options.params).map(([k, v]) => `${k}=${v}`).join('&')
      url = `${url}?${query}`
    }

    let resp: Response
    try {
      resp = await fetch(url, {
        method: options.method ?? 'GET',
        headers: mergedHeaders,
        ...options.body !== undefined ? { body: options.body } : {},
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`dbx 连接失败: ${errorMessage(cause)}`)
    }

    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`dbx HTTP ${resp.status}: ${detail}`)
    }

    try {
      return await resp.json()
    } catch (cause) {
      throw new Error(`dbx 响应不是合法 JSON: ${errorMessage(cause)}`)
    }
  }

  /** `GET /api/auth/check`; 401/403 means the session is dead, other errors propagate. */
  private async checkAuth(session: string): Promise<boolean> {
    try {
      const resp = await this.request('/api/auth/check', { session })
      return Boolean(isRecord(resp) && resp['authenticated'])
    } catch (error) {
      const text = errorMessage(error)
      if (text.includes('401') || text.includes('403')) return false
      throw error
    }
  }

  /**
   * `POST /api/auth/login` with `{"password": ...}`; extracts the
   * `dbx_session` cookie from `Set-Cookie`. Port of `dbx.py._login`.
   */
  private async login(oldSession?: string): Promise<string> {
    const password = await this.resolvePassword()

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      referer: `${this.endpoint}/login`,
    }
    // 叠加标准头（不覆盖显式设置的 content-type / referer）
    for (const [key, value] of Object.entries(DBX_BASE_HEADERS)) {
      if (!(key in headers)) headers[key] = value
    }
    headers['origin'] = this.endpoint
    if (oldSession) headers['cookie'] = `${SESSION_COOKIE}=${oldSession}`

    let resp: Response
    try {
      resp = await fetch(`${this.endpoint}/api/auth/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`dbx 登录连接失败: ${errorMessage(cause)}`)
    }

    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`dbx 登录失败 HTTP ${resp.status}: ${detail}`)
    }

    const session = extractCookie(resp, SESSION_COOKIE)
    if (!session) {
      const body = await resp.text()
      throw new Error(`登录成功但未返回 dbx_session cookie，响应: ${body.slice(0, 200)}`)
    }
    return session
  }

  /**
   * Ensure a valid `dbx_session`, refreshing it when missing, TTL-expired, or
   * server-rejected. Port of `dbx.py.ensure_session` (with the TTL check of
   * `auth_cache.load_session` inlined), plus single-flight login sharing.
   */
  async ensureSession(): Promise<string> {
    const cached = this.sessionEntry !== undefined && this.sessionEntry.expiresAt > Date.now()
      ? this.sessionEntry.value
      : undefined
    if (cached !== undefined && await this.checkAuth(cached)) return cached

    // Single-flight: concurrent refreshes share one login. The scripts were
    // single-threaded, so this is a Cordis-era addition, not a port.
    this.loginPromise ??= this.login(cached)
      .then((session) => {
        this.sessionEntry = { value: session, expiresAt: Date.now() + this.sessionTtlMs }
        return session
      })
      .finally(() => {
        this.loginPromise = undefined
      })
    return this.loginPromise
  }

  /**
   * Drop all cached auth state. Port of `auth_cache.clear_session`, which
   * deleted the whole `dbx` provider entry — session AND the discovered
   * connections/databases under it — so the next discovery starts fresh.
   */
  clearSession(): void {
    this.sessionEntry = undefined
    this.connectionCache.clear()
    this.databaseCache.clear()
  }

  /** Read the cached discovery result for a connection type, or `undefined` when missing/expired. */
  getCachedConnection(connType: string): DbxConnection | undefined {
    const entry = this.connectionCache.get(connType)
    if (entry === undefined || entry.expiresAt <= Date.now()) return undefined
    return { id: entry.id, config: entry.config }
  }

  /** `GET /api/connection/list`; accepts a bare list or `{connections: [...]}`. */
  private async listConnections(session: string): Promise<Record<string, unknown>[]> {
    const resp = await this.request('/api/connection/list', { session })
    if (Array.isArray(resp)) return resp as Record<string, unknown>[]
    if (isRecord(resp)) {
      const connections = resp['connections']
      if (Array.isArray(connections)) return connections as Record<string, unknown>[]
    }
    throw new Error(`dbx /api/connection/list 返回格式异常: ${JSON.stringify(resp)}`)
  }

  /**
   * `POST /api/connection/connect` with `{"config": candidate}`; returns the
   * activated connection id. Port of `dbx.py._connect_connection`.
   */
  private async connectConnection(
    session: string,
    candidate: Record<string, unknown>,
  ): Promise<string> {
    const resp = await this.request('/api/connection/connect', {
      method: 'POST',
      body: JSON.stringify({ config: candidate }),
      headers: { 'content-type': 'application/json' },
      session,
    })
    if (typeof resp === 'string') return resp
    if (isRecord(resp)) {
      return (resp['id'] || resp['connection_id'] || candidate['id']) as string
    }
    throw new Error(`dbx /api/connection/connect 返回无法解析的连接 ID: ${JSON.stringify(resp)}`)
  }

  /**
   * Discover a dbx connection of the given type, preferring the cache and
   * falling back to list + pick + connect (with cache write-back). Port of
   * `dbx.py.discover_connection`.
   */
  async discoverConnection(connType: string, preferredId?: string): Promise<DbxConnection> {
    const cached = this.getCachedConnection(connType)
    if (cached !== undefined && (!preferredId || cached.id === preferredId)) return cached

    const session = await this.ensureSession()
    const connections = await this.listConnections(session)
    const candidate = pickDbxConnection(connections, connType, preferredId || cached?.id)
    if (candidate === undefined) {
      const available = connections.map(c => c['id'] ?? c['name'])
      throw new Error(`dbx 未找到类型 ${connType} 的连接，可用连接: ${JSON.stringify(available)}`)
    }

    const id = await this.connectConnection(session, candidate)
    this.connectionCache.set(connType, { id, config: candidate, expiresAt: Date.now() + this.cacheTtlMs })
    return { id, config: candidate }
  }

  /**
   * Execute an operation against a connection with the scripts' fallback
   * choreography. Port of `_execute_with_fallback` (db-inspector) and
   * `_query_with_fallback` (redis-inspector), which were identical in shape:
   *
   * 1. try the given connection id;
   * 2. on a 401/403 (first failure only) drop all cached auth state, re-login,
   *    and retry the same id;
   * 3. on any other failure — or a repeated auth failure — auto-discover a
   *    fresh connection of `connType` and run once more.
   *
   * `preferredId || startConnectionId` follows Python `or` semantics: an
   * empty start id falls through, matching `preferred_id or connection_id`.
   */
  async runWithFallback<T>(
    connType: string,
    startConnectionId: string,
    preferredId: string | undefined,
    fn: (connectionId: string) => Promise<T>,
  ): Promise<{ value: T; connectionId: string }> {
    for (let refresh = 0; refresh < 2; refresh++) {
      try {
        return { value: await fn(startConnectionId), connectionId: startConnectionId }
      } catch (error) {
        const text = errorMessage(error)
        if ((text.includes('401') || text.includes('403')) && refresh === 0) {
          this.clearSession()
          await this.ensureSession()
          continue
        }
        break
      }
    }
    const discovered = await this.discoverConnection(connType, preferredId || startConnectionId || undefined)
    return { value: await fn(discovered.id), connectionId: discovered.id }
  }

  /**
   * Database list of a connection, cached per `connection_id`. Port of
   * `dbx.py.list_databases` (`GET /api/schema/databases?connection_id=...`).
   */
  async listDatabases(connectionId: string): Promise<string[]> {
    const cached = this.databaseCache.get(connectionId)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.names

    const session = await this.ensureSession()
    const resp = await this.request('/api/schema/databases', {
      params: { connection_id: connectionId },
      session,
    })

    let names: string[]
    if (Array.isArray(resp)) {
      names = resp.filter(isRecord).map(c => c['name'] as string)
    } else if (isRecord(resp)) {
      const items = resp['databases']
      names = (Array.isArray(items) ? items : []).filter(isRecord).map(c => c['name'] as string)
    } else {
      throw new Error(`dbx /api/schema/databases 返回格式异常: ${JSON.stringify(resp)}`)
    }

    this.databaseCache.set(connectionId, { names, expiresAt: Date.now() + this.cacheTtlMs })
    return names
  }

  /**
   * Execute SQL through `POST /api/query/execute-multi`. Port of
   * `dbx.py.execute_query`, including its response quirk: a dict response
   * with an EMPTY `results` list falls back to `[resp]` (Python
   * `resp.get("results", []) or [resp]`).
   */
  async executeQuery(
    connectionId: string,
    database: string,
    sql: string,
    options?: { maxRows?: number; timeoutSecs?: number },
  ): Promise<Record<string, unknown>[]> {
    const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS
    const session = await this.ensureSession()
    const body = {
      connectionId,
      database,
      sql,
      executionId: randomUUID(),
      maxRows,
      fetchSize: maxRows,
      clientSessionId: randomUUID(),
      timeoutSecs: options?.timeoutSecs ?? DEFAULT_QUERY_TIMEOUT_SECS,
    }
    const resp = await this.request('/api/query/execute-multi', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      session,
    })
    if (Array.isArray(resp)) return resp as Record<string, unknown>[]
    if (isRecord(resp)) {
      const results = resp['results']
      return (Array.isArray(results) && results.length > 0 ? results : [resp]) as Record<string, unknown>[]
    }
    throw new Error(`dbx /api/query/execute-multi 返回格式异常: ${JSON.stringify(resp)}`)
  }

  /**
   * Query a Redis key through `POST /api/redis/get-value`. Port of
   * `_query_value` from `skills/redis-inspector/scripts/inspect.py` (moved
   * here so all dbx wire formats live in the service package); the key is
   * base64-encoded into `keyRaw` exactly as the script did. The script passed
   * an explicit `referer` header identical to the one `dbx_request` forces
   * anyway, so it is omitted here with no wire change. Read-only.
   */
  async redisGetValue(connectionId: string, db: number, key: string): Promise<Record<string, unknown>> {
    const session = await this.ensureSession()
    const keyRaw = Buffer.from(key, 'utf8').toString('base64')
    const resp = await this.request('/api/redis/get-value', {
      method: 'POST',
      body: JSON.stringify({ connectionId, db, keyRaw }),
      headers: { 'content-type': 'application/json' },
      session,
    })
    return resp as Record<string, unknown>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dbx: DbxService
  }
}

export default DbxService
