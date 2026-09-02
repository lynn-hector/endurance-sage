/**
 * Prometheus HTTP API client (`/api/v1/query_range` + `/api/v1/rules`) as a
 * Cordis service.
 *
 * Port of the transport half of the original metrics-inspector scripts
 * (`skills/metrics-inspector/scripts/query_metrics.py::_query_prometheus` and
 * `list_alerts.py::_fetch_rules`): GET with an `Accept: application/json`
 * header, optional Bearer/Basic auth (direct mode), a 30s timeout, and the
 * original Chinese error wording (`Prometheus HTTP {code}: {body}`,
 * `请求 Prometheus 失败: ...`).
 *
 * Differences from the script era:
 * - credentials resolve per request through the ambient credential plane
 *   (`@dsh-sentry/datasource`), so a hot-reloaded credential store takes
 *   effect without restarting; auth is fully optional because the original
 *   `local` environment connected anonymously;
 * - grafana-proxy mode gains an auth mechanism the script never had: with no
 *   Bearer token configured, username/password buys a `grafana_session` via
 *   form login (`POST /login`, the service-trace mechanism), cached in
 *   memory with a 24h TTL and refreshed once on 401/403 — the one
 *   password-based style that works on instances with basic auth disabled
 *   (tst three, DC0);
 * - transport failures are uniformly wrapped as `请求 Prometheus 失败: ...`;
 *   the original `list_alerts.py` let non-HTTP urllib errors propagate raw
 *   (their wording was exception-type specific and has no stable string to
 *   preserve);
 * - `query_range` timestamps are formatted like Python's `urlencode` of
 *   floats (integral values keep a trailing `.0`), so request URLs match the
 *   original byte-for-byte apart from the unreserved-character set of
 *   `URLSearchParams` vs `urllib.parse.urlencode` (e.g. `*`), which decodes
 *   identically on the server.
 *
 * @module @dsh-sentry/service-prometheus
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  credentialRefField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

const SESSION_COOKIE = 'grafana_session'

/** In-memory session TTL default, matching service-trace (`auth_cache._DEFAULT_TTL_HOURS`). */
const DEFAULT_SESSION_TTL_MS = 24 * 3600 * 1000

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Prometheus HTTP base, e.g. `http://localhost:9090`. Unused in grafana-proxy mode. */
  /** Prometheus HTTP 地址；grafana 代理模式下省略（二选一）。 */
  endpoint?: string
  /**
   * Grafana base URL, e.g. `https://grafana.cn-0.dev.novo-one.com`. When set,
   * PromQL goes through Grafana's `/api/ds/query` datasource proxy (the
   * deployment queries Prometheus exclusively through Grafana — the raw
   * Prometheus API is not exposed). Username/password/token refs then apply
   * to the Grafana side.
   */
  grafanaEndpoint?: string
  /** Prometheus datasource uid inside Grafana, default `prometheus`. */
  datasourceUid?: string
  /** Credential reference for the Bearer token, e.g. `PROMETHEUS_PRODUCTION_TOKEN`. */
  tokenRef?: string
  /** Credential reference for the Basic-auth username. */
  usernameRef?: string
  /** Credential reference for the Basic-auth password. */
  passwordRef?: string
  /** Literal Bearer token fallback when no reference is configured. Discouraged in composition files. */
  token?: string
  /** Literal username fallback when no reference is configured. Discouraged in composition files. */
  username?: string
  /** Literal password fallback when no reference is configured. Discouraged in composition files. */
  password?: string
  /** Per-request timeout in milliseconds. Defaults to 30000 (the original script's urlopen timeout). */
  timeoutMs?: number
  /** In-memory `grafana_session` TTL in milliseconds (proxy-mode form login). Defaults to 24h, matching service-trace. */
  sessionTtlMs?: number
}

export class PrometheusService extends Service {
  static Config: z<Config> = z.object({
    endpoint: z.string().description('Prometheus HTTP 地址，如 http://localhost:9090（grafana 代理模式下省略）'),
    grafanaEndpoint: z.string().description('Grafana 地址；设置后 PromQL 经 /api/ds/query 代理查询（该部署的 Prometheus 只经 Grafana 暴露）'),
    datasourceUid: z.string().default('prometheus').description('Grafana 内 Prometheus 数据源 uid，默认 prometheus'),
    tokenRef: credentialRefField('Bearer token 的凭据引用，如 PROMETHEUS_PRODUCTION_TOKEN'),
    usernameRef: credentialRefField('Basic 认证用户名的凭据引用'),
    passwordRef: credentialRefField('Basic 认证密码的凭据引用'),
    token: secretField('内联 Bearer token（credential ref 优先；不推荐写在组合文件）'),
    username: secretField('内联用户名（credential ref 优先；不推荐写在组合文件）'),
    password: secretField('内联密码（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
    sessionTtlMs: z.number().step(1).min(1).default(DEFAULT_SESSION_TTL_MS)
      .description('grafana_session 内存缓存 TTL（毫秒），默认 24 小时（grafana 代理模式的表单登录）'),
  })

  /** Configured base URL with trailing slashes stripped (the original `rstrip("/")`). */
  readonly endpoint: string
  /** Grafana proxy base when configured, trailing slashes stripped. */
  readonly grafanaEndpoint: string
  private readonly timeoutMs: number
  private readonly sessionTtlMs: number

  /**
   * In-memory grafana_session cache (proxy-mode form login), the
   * service-trace pattern: lazily re-validated on read, dropped on teardown
   * so a reloaded plugin never holds a stale cookie.
   */
  private session: { value: string; expiresAt: number } | undefined
  /** Single-flight form login: concurrent first callers share one `/login` (the dbx/rocketmq pattern). */
  private loginFlight: Promise<string> | null = null

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'prometheus')
    // The schema already defaulted optional fields under the Loader; the ??
    // narrows the type for direct (non-Loader) construction in tests.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.grafanaEndpoint = (config.grafanaEndpoint ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.config = config
    // The session is in-memory and dies with the fiber anyway; dropping it on
    // teardown just keeps a reloaded plugin from holding a stale cookie.
    ctx.effect(() => () => {
      this.session = undefined
    })
  }

  private readonly config: Config

  /** Resolve the Bearer token when one is configured: reference wins over the literal fallback. */
  private async bearerToken(): Promise<string | undefined> {
    let token: string | undefined
    if (this.config.tokenRef !== undefined) {
      token = await resolveCredential(this.ctx, this.config.tokenRef)
    }
    token ??= this.config.token
    return token !== undefined && token.length > 0 ? token : undefined
  }

  /** Resolve the username/password pair: references win over literal fallbacks; undefined when incomplete. */
  private async loginCredentials(): Promise<{ username: string; password: string } | undefined> {
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
    if (!username || !password) return undefined
    return { username, password }
  }

  /**
   * Direct-mode auth — the original `_build_auth_header`, verbatim
   * semantics: a resolved Bearer token wins; otherwise a resolved
   * username+password pair yields Basic auth; with neither, the request goes
   * out anonymously (the original `local` environment).
   */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.bearerToken()
    if (token !== undefined) return { authorization: `Bearer ${token}` }
    const credentials = await this.loginCredentials()
    if (credentials !== undefined) {
      const creds = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')
      return { authorization: `Basic ${creds}` }
    }
    return {}
  }

  /**
   * Proxy-mode auth (new code; the script only knew Basic): a resolved
   * Bearer token still wins; otherwise username/password buys a
   * `grafana_session` via form login — the service-trace mechanism, and the
   * one password-based style that works on instances with basic auth
   * disabled (tst three, DC0). With neither, anonymous. `retriable` marks
   * session auth: a rejected session can heal itself with a fresh login, a
   * rejected Bearer token cannot.
   */
  private async proxyAuth(): Promise<{ headers: Record<string, string>; retriable: boolean }> {
    const token = await this.bearerToken()
    if (token !== undefined) return { headers: { authorization: `Bearer ${token}` }, retriable: false }
    const credentials = await this.loginCredentials()
    if (credentials === undefined) return { headers: {}, retriable: false }
    const session = await this.ensureSession(credentials)
    return { headers: { cookie: `${SESSION_COOKIE}=${session}` }, retriable: true }
  }

  private loadSession(): string | undefined {
    if (this.session === undefined) return undefined
    if (Date.now() > this.session.expiresAt) {
      this.session = undefined
      return undefined
    }
    return this.session.value
  }

  private saveSession(value: string): void {
    this.session = { value, expiresAt: Date.now() + this.sessionTtlMs }
  }

  private clearSession(): void {
    this.session = undefined
  }

  /**
   * Form login against the Grafana endpoint (`POST /login`), the
   * service-trace mechanism and error wording: extract `grafana_session`
   * from Set-Cookie.
   */
  private async login(username: string, password: string): Promise<string> {
    let resp: Response
    try {
      resp = await fetch(`${this.grafanaEndpoint}/login`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: this.grafanaEndpoint,
          referer: `${this.grafanaEndpoint}/login`,
        },
        body: JSON.stringify({ user: username, password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`Grafana 登录连接失败: ${errorMessage(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`Grafana 登录失败 HTTP ${resp.status}: ${detail}`)
    }
    const session = extractCookie(resp.headers, SESSION_COOKIE)
    if (!session) {
      const body = await resp.text()
      throw new Error(`登录成功但未返回 grafana_session cookie，响应: ${body.slice(0, 200)}`)
    }
    return session
  }

  /** Cached session when valid; otherwise one single-flight form login. */
  private async ensureSession(credentials: { username: string; password: string }): Promise<string> {
    const cached = this.loadSession()
    if (cached !== undefined) return cached
    this.loginFlight ??= this.login(credentials.username, credentials.password)
      .then((session) => {
        this.saveSession(session)
        return session
      })
      .finally(() => {
        this.loginFlight = null
      })
    return this.loginFlight
  }

  /** GET JSON with the original script's error wording. */
  private async getJson(url: string): Promise<unknown> {
    if (this.endpoint.length === 0) {
      throw new Error('endpoint 未配置，请检查插件配置')
    }
    return this.getJsonUrl(url)
  }

  /**
   * GET JSON against any absolute URL (used by proxy-mode requests whose
   * base is the Grafana endpoint). Proxy mode authenticates via
   * {@link proxyAuth} and retries exactly once with a fresh login when the
   * session was rejected (401/403); direct mode keeps the original
   * single-shot behavior.
   */
  private async getJsonUrl(url: string): Promise<unknown> {
    if (!this.proxied) {
      return this.getJsonWithHeaders(url, { accept: 'application/json', ...await this.authHeaders() })
    }
    const auth = await this.proxyAuth()
    try {
      return await this.getJsonWithHeaders(url, { accept: 'application/json', ...auth.headers })
    } catch (error) {
      if (!auth.retriable || !looksLikeAuthError(error)) throw error
      this.clearSession()
      const retryAuth = await this.proxyAuth()
      return this.getJsonWithHeaders(url, { accept: 'application/json', ...retryAuth.headers })
    }
  }

  /** GET JSON with the original script's error wording (`Prometheus HTTP {code}: {body}`, `请求 Prometheus 失败: ...`). */
  private async getJsonWithHeaders(url: string, headers: Record<string, string>): Promise<unknown> {
    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`请求 Prometheus 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`Prometheus HTTP ${resp.status}: ${detail}`)
    }

    try {
      return await resp.json()
    } catch (cause) {
      throw new Error(`请求 Prometheus 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /** True when PromQL goes through the Grafana datasource proxy. */
  get proxied(): boolean {
    return this.grafanaEndpoint.length > 0
  }

  /** Constructed grafana proxy request body, for tests and dry-run evidence. */
  buildProxyBody(query: string, startSec: number, endSec: number): Record<string, unknown> {
    return {
      from: `${Math.round(startSec * 1000)}`,
      to: `${Math.round(endSec * 1000)}`,
      queries: [{
        refId: 'A',
        expr: query,
        range: true,
        datasource: { type: 'prometheus', uid: this.config.datasourceUid ?? 'prometheus' },
      }],
    }
  }

  /**
   * Range query. Direct mode: GET `/api/v1/query_range` (original port).
   * Grafana-proxy mode: POST `/api/ds/query`, converting the Grafana frames
   * back into the Prometheus `query_range` envelope so downstream parsing
   * (tool layer, evidence shape) is mode-agnostic.
   */
  async queryRange(query: string, start: number, end: number, step: string): Promise<unknown> {
    if (!this.proxied) {
      const params = new URLSearchParams({
        query,
        start: formatPyFloat(start),
        end: formatPyFloat(end),
        step,
      })
      return this.getJson(`${this.endpoint}/api/v1/query_range?${params.toString()}`)
    }

    const body = JSON.stringify(this.buildProxyBody(query, start, end))
    const auth = await this.proxyAuth()
    try {
      return await this.postProxyQuery(body, auth.headers)
    } catch (error) {
      // Same retry contract as getJsonUrl: a rejected session re-logins once.
      if (!auth.retriable || !looksLikeAuthError(error)) throw error
      this.clearSession()
      const retryAuth = await this.proxyAuth()
      return this.postProxyQuery(body, retryAuth.headers)
    }
  }

  /** POST one `/api/ds/query` body and convert the Grafana frames back into the query_range envelope. */
  private async postProxyQuery(body: string, authHeaders: Record<string, string>): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...authHeaders,
    }
    let resp: Response
    try {
      resp = await fetch(`${this.grafanaEndpoint}/api/ds/query`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`请求 Prometheus 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`Grafana HTTP ${resp.status}: ${detail}`)
    }
    let payload: unknown
    try {
      payload = await resp.json()
    } catch (cause) {
      throw new Error(`请求 Prometheus 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return framesToQueryRangeEnvelope(payload)
  }

  /**
   * GET `/api/v1/rules` (alerting and recording rules with current state).
   * The Grafana datasource proxy has no equivalent for the rules API, so
   * proxy mode fails loudly instead of pretending.
   */
  async rules(): Promise<unknown> {
    if (this.proxied) {
      throw new Error('告警查询需要直连 Prometheus API（/api/v1/rules）；当前为 grafana 代理模式，告警接口不可达')
    }
    return this.getJson(`${this.endpoint}/api/v1/rules`)
  }

  /**
   * Constructed label-values request, for dry-run evidence. Proxied mode
   * goes through Grafana's datasource resources passthrough
   * (`/api/datasources/uid/<uid>/resources/api/v1/...`), which forwards the
   * Prometheus envelope unchanged.
   */
  buildLabelValuesRequest(label: string, windowMinutes: number, limit: number): { url: string; params: Record<string, string> } {
    const base = this.proxied
      ? `${this.grafanaEndpoint}/api/datasources/uid/${this.config.datasourceUid ?? 'prometheus'}/resources/api/v1`
      : `${this.endpoint}/api/v1`
    return {
      url: `${base}/label/${encodeURIComponent(label)}/values`,
      params: {
        start: String(Math.floor(Date.now() / 1000) - windowMinutes * 60),
        end: String(Math.floor(Date.now() / 1000)),
        limit: String(limit),
      },
    }
  }

  /**
   * Label values (e.g. `__name__` = every metric name active in the window).
   * Works in both modes; returns the names sorted.
   */
  async labelValues(label: string, options?: { windowMinutes?: number; limit?: number }): Promise<string[]> {
    const windowMinutes = options?.windowMinutes ?? 60
    const limit = options?.limit ?? 40000
    const { url, params } = this.buildLabelValuesRequest(label, windowMinutes, limit)
    if (!this.proxied && this.endpoint.length === 0) {
      throw new Error('endpoint 未配置，请检查插件配置')
    }
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    const payload = await this.getJsonUrl(`${url}?${qs}`)
    const data = isRecord(payload) ? payload['data'] : undefined
    if (!Array.isArray(data)) {
      throw new Error(
        `Prometheus label values 返回的数据格式无法解析，原始响应：${JSON.stringify(payload).slice(0, 500)}`,
      )
    }
    return data.filter((v): v is string => typeof v === 'string').sort()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Port of service-trace's `_extract_cookie`: the first `Set-Cookie` whose name matches wins. */
function extractCookie(headers: Headers, name: string): string | undefined {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  const rawCookies = typeof withGetSetCookie.getSetCookie === 'function'
    ? withGetSetCookie.getSetCookie()
    : (headers.get('set-cookie') !== null ? [headers.get('set-cookie')!] : [])
  for (const cookie of rawCookies) {
    if (cookie.startsWith(`${name}=`)) {
      const pair = cookie.split(';', 1)[0]!
      return pair.slice(pair.indexOf('=') + 1)
    }
  }
  return undefined
}

/** service-trace's `_looks_like_auth_error` heuristic: any "401"/"403" substring counts. */
function looksLikeAuthError(error: unknown): boolean {
  const text = errorMessage(error)
  return text.includes('401') || text.includes('403')
}

/**
 * Convert a Grafana `/api/ds/query` response (arrow-style frames) into the
 * Prometheus `/api/v1/query_range` envelope `{status, data:{result:[...]}}`:
 * each frame becomes one series `{metric: labels, values: [[ts, str(v)]…]}`.
 * Unknown shapes yield an empty success envelope — the downstream parser
 * treats "no series" as zero data points, matching direct mode.
 */
export function framesToQueryRangeEnvelope(payload: unknown): unknown {
  const result: { metric: Record<string, string>; values: [number, string][] }[] = []
  if (typeof payload === 'object' && payload !== null) {
    const results = (payload as Record<string, unknown>)['results']
    if (typeof results === 'object' && results !== null) {
      for (const frameSet of Object.values(results as Record<string, unknown>)) {
        if (typeof frameSet !== 'object' || frameSet === null) continue
        const frames = (frameSet as Record<string, unknown>)['frames']
        if (!Array.isArray(frames)) continue
        for (const frame of frames) {
          if (typeof frame !== 'object' || frame === null) continue
          const record = frame as Record<string, unknown>
          const schema = typeof record['schema'] === 'object' && record['schema'] !== null
            ? record['schema'] as Record<string, unknown>
            : {}
          const fields = Array.isArray(schema['fields']) ? schema['fields'] as Record<string, unknown>[] : []
          const data = typeof record['data'] === 'object' && record['data'] !== null
            ? record['data'] as Record<string, unknown>
            : {}
          const columns = Array.isArray(data['values']) ? data['values'] as unknown[][] : []
          if (fields.length < 2 || columns.length < 2) continue

          // Frame layout: field[0]/column[0] = Time, field[1]/column[1] = value.
          const labels = typeof fields[1]?.['labels'] === 'object' && fields[1]!['labels'] !== null
            ? fields[1]!['labels'] as Record<string, unknown>
            : {}
          const metric: Record<string, string> = {}
          for (const [k, v] of Object.entries(labels)) {
            if (typeof v === 'string') metric[k] = v
          }
          const times = columns[0] ?? []
          const values = columns[1] ?? []
          const pairs: [number, string][] = []
          for (let i = 0; i < Math.min(times.length, values.length); i++) {
            const ts = Number(times[i])
            if (!Number.isFinite(ts)) continue
            const raw = values[i]
            pairs.push([ts, typeof raw === 'string' ? raw : String(raw)])
          }
          result.push({ metric, values: pairs })
        }
      }
    }
  }
  return { status: 'success', data: { resultType: 'matrix', result } }
}

/**
 * Format a number the way Python's `str(float)` renders it inside
 * `urllib.parse.urlencode`: integral values keep a trailing `.0`
 * (`1784714400.0`), fractional values render plainly. Prometheus timestamps
 * never reach the ranges where Python switches to exponent notation.
 */
export function formatPyFloat(value: number): string {
  if (Number.isFinite(value) && Number.isInteger(value)) return `${value}.0`
  return String(value)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    prometheus: PrometheusService
  }
}

export default PrometheusService
