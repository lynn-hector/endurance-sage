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
 *   form login, cached in memory with a 24h TTL and refreshed once on a
 *   structured 401/403 — the shared `GrafanaSessionKeeper` from
 *   `@dsh-sentry/datasource` (the one password-based style that works on
 *   instances with basic auth disabled — tst three, DC0);
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
  GrafanaSessionKeeper,
  HttpError,
  isAuthFailureError,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

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
  /** Prometheus datasource uid inside Grafana (schema default applied), for URLs and evidence refs. */
  readonly datasourceUid: string
  private readonly timeoutMs: number
  private readonly sessionTtlMs: number
  /** Shared form-login session keeper (`@dsh-sentry/datasource`), proxy mode only. */
  private readonly keeper: GrafanaSessionKeeper

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'prometheus')
    // The schema already defaulted optional fields under the Loader; the ??
    // narrows the type for direct (non-Loader) construction in tests.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.grafanaEndpoint = (config.grafanaEndpoint ?? '').replace(/\/+$/, '')
    this.datasourceUid = config.datasourceUid ?? 'prometheus'
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.config = config
    this.keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: this.grafanaEndpoint,
      resolveCredentials: () => this.loginCredentials(),
      timeoutMs: this.timeoutMs,
      sessionTtlMs: this.sessionTtlMs,
    })
    // The session is in-memory and dies with the fiber anyway; dropping it on
    // teardown just keeps a reloaded plugin from holding a stale cookie.
    ctx.effect(() => () => this.keeper.clearSession())
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
   * Bearer token still wins (`retriable: false` — a rejected token cannot
   * heal); otherwise the shared `GrafanaSessionKeeper` manages the form-login
   * session (`retriable: true`). With neither, anonymous.
   */
  private async proxyAuth(): Promise<{ headers: Record<string, string>; retriable: boolean }> {
    const token = await this.bearerToken()
    if (token !== undefined) return { headers: { authorization: `Bearer ${token}` }, retriable: false }
    return this.keeper.authHeaders()
  }

  /**
   * GET JSON against any absolute URL (used by proxy-mode requests whose
   * base is the Grafana endpoint). Guards the endpoint first (direct mode
   * without one would build a relative URL and fail with a confusing
   * "Failed to parse URL"); proxy mode authenticates via {@link proxyAuth}
   * and retries exactly once with a fresh login when the session was
   * rejected (401/403 — structured status, never message-text parsing);
   * direct mode keeps the original single-shot behavior.
   */
  private async getJsonUrl(url: string): Promise<unknown> {
    this.requireEndpoint()
    if (!this.proxied) {
      return this.getJsonWithHeaders(url, { accept: 'application/json', ...await this.authHeaders() })
    }
    const auth = await this.proxyAuth()
    try {
      return await this.getJsonWithHeaders(url, { accept: 'application/json', ...auth.headers })
    } catch (error) {
      if (!auth.retriable || !isAuthFailureError(error)) throw error
      this.keeper.clearSession()
      const retryAuth = await this.proxyAuth()
      return this.getJsonWithHeaders(url, { accept: 'application/json', ...retryAuth.headers })
    }
  }

  /** Endpoint guard: direct mode needs an endpoint; proxied mode reads Grafana's. */
  private requireEndpoint(): void {
    if (!this.proxied && this.endpoint.length === 0) {
      throw new Error('endpoint 未配置，请检查插件配置')
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
      throw new HttpError(`Prometheus HTTP ${resp.status}: ${detail}`, resp.status)
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
        datasource: { type: 'prometheus', uid: this.datasourceUid },
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
      return this.getJsonUrl(this.buildRangeRequest(query, start, end, step).url)
    }

    const body = JSON.stringify(this.buildProxyBody(query, start, end))
    const auth = await this.proxyAuth()
    try {
      return await this.postProxyQuery(body, auth.headers)
    } catch (error) {
      // Same retry contract as getJsonUrl: a rejected session re-logins once.
      if (!auth.retriable || !isAuthFailureError(error)) throw error
      this.keeper.clearSession()
      const retryAuth = await this.proxyAuth()
      return this.postProxyQuery(body, retryAuth.headers)
    }
  }

  /** Constructed range-query request, for tests and dry-run evidence. */
  buildRangeRequest(query: string, start: number, end: number, step: string): { url: string; body?: Record<string, unknown> } {
    if (!this.proxied) {
      const params = new URLSearchParams({
        query,
        start: formatPyFloat(start),
        end: formatPyFloat(end),
        step,
      })
      return { url: `${this.endpoint}/api/v1/query_range?${params.toString()}` }
    }
    return { url: `${this.grafanaEndpoint}/api/ds/query`, body: this.buildProxyBody(query, start, end) }
  }

  /** Constructed instant-query request, for tests and dry-run evidence. */
  buildInstantRequest(query: string, timeSec: number): { url: string } {
    const params = new URLSearchParams({ query, time: formatPyFloat(timeSec) })
    const url = this.proxied
      ? `${this.grafanaEndpoint}/api/datasources/uid/${this.datasourceUid}/resources/api/v1/query?${params.toString()}`
      : `${this.endpoint}/api/v1/query?${params.toString()}`
    return { url }
  }

  /**
   * Instant query (single-point evaluation at `timeSec`). Direct mode: GET
   * `/api/v1/query`; proxied mode: the same resources passthrough as
   * `rules()` — the envelope comes back unchanged, no frame conversion.
   */
  async queryInstant(query: string, timeSec: number): Promise<unknown> {
    return this.getJsonUrl(this.buildInstantRequest(query, timeSec).url)
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
      throw new HttpError(`Grafana HTTP ${resp.status}: ${detail}`, resp.status)
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
   * Grafana-proxy mode goes through the datasource resources passthrough
   * (`/api/datasources/uid/<uid>/resources/api/v1/rules`), which forwards
   * the Prometheus envelope unchanged — same mechanism as `labelValues`.
   */
  buildRulesRequest(): { url: string } {
    const url = this.proxied
      ? `${this.grafanaEndpoint}/api/datasources/uid/${this.datasourceUid}/resources/api/v1/rules`
      : `${this.endpoint}/api/v1/rules`
    return { url }
  }

  async rules(): Promise<unknown> {
    return this.getJsonUrl(this.buildRulesRequest().url)
  }

  /**
   * Constructed label-values request, for dry-run evidence. Proxied mode
   * goes through Grafana's datasource resources passthrough
   * (`/api/datasources/uid/<uid>/resources/api/v1/...`), which forwards the
   * Prometheus envelope unchanged.
   */
  buildLabelValuesRequest(label: string, windowMinutes: number, limit: number): { url: string; params: Record<string, string> } {
    const base = this.proxied
      ? `${this.grafanaEndpoint}/api/datasources/uid/${this.datasourceUid}/resources/api/v1`
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
