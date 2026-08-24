/**
 * Prometheus HTTP API client (`/api/v1/query_range` + `/api/v1/rules`) as a
 * Cordis service.
 *
 * Port of the transport half of the original metrics-inspector scripts
 * (`skills/metrics-inspector/scripts/query_metrics.py::_query_prometheus` and
 * `list_alerts.py::_fetch_rules`): GET with an `Accept: application/json`
 * header, optional Bearer/Basic auth, a 30s timeout, and the original Chinese
 * error wording (`Prometheus HTTP {code}: {body}`, `请求 Prometheus 失败: ...`).
 *
 * Differences from the script era:
 * - credentials resolve per request through the ambient credential plane
 *   (`@dsh-sentry/datasource`), so a hot-reloaded credential store takes
 *   effect without restarting; auth is fully optional because the original
 *   `local` environment connected anonymously;
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
  endpointField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Prometheus HTTP base, e.g. `http://localhost:9090`. */
  endpoint: string
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
}

export class PrometheusService extends Service {
  static Config: z<Config> = z.object({
    endpoint: endpointField('Prometheus HTTP 地址，如 http://localhost:9090'),
    tokenRef: credentialRefField('Bearer token 的凭据引用，如 PROMETHEUS_PRODUCTION_TOKEN'),
    usernameRef: credentialRefField('Basic 认证用户名的凭据引用'),
    passwordRef: credentialRefField('Basic 认证密码的凭据引用'),
    token: secretField('内联 Bearer token（credential ref 优先；不推荐写在组合文件）'),
    username: secretField('内联用户名（credential ref 优先；不推荐写在组合文件）'),
    password: secretField('内联密码（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
  })

  /** Configured base URL with trailing slashes stripped (the original `rstrip("/")`). */
  readonly endpoint: string
  private readonly timeoutMs: number

  constructor(ctx: Context, config: Config = { endpoint: '' }) {
    super(ctx, 'prometheus')
    // The schema already defaulted optional fields under the Loader; the ??
    // narrows the type for direct (non-Loader) construction in tests.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.config = config
  }

  private readonly config: Config

  /**
   * Original `_build_auth_header`, verbatim semantics: a resolved Bearer
   * token wins; otherwise a resolved username+password pair yields Basic
   * auth; with neither, the request goes out anonymously (the original
   * `local` environment). References win over literal fallbacks.
   */
  private async authHeaders(): Promise<Record<string, string>> {
    let token: string | undefined
    if (this.config.tokenRef !== undefined) {
      token = await resolveCredential(this.ctx, this.config.tokenRef)
    }
    token ??= this.config.token
    if (token) return { authorization: `Bearer ${token}` }

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
    if (username && password) {
      const creds = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
      return { authorization: `Basic ${creds}` }
    }
    return {}
  }

  /** GET JSON with the original script's error wording. */
  private async getJson(url: string): Promise<unknown> {
    if (this.endpoint.length === 0) {
      throw new Error('endpoint 未配置，请检查插件配置')
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...await this.authHeaders(),
    }

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

  /**
   * GET `/api/v1/query_range`.
   * @param query - final PromQL expression.
   * @param start - range start, UTC seconds.
   * @param end - range end, UTC seconds.
   * @param step - query resolution step, e.g. `15s`.
   * @returns the raw parsed Prometheus response envelope.
   */
  async queryRange(query: string, start: number, end: number, step: string): Promise<unknown> {
    const params = new URLSearchParams({
      query,
      start: formatPyFloat(start),
      end: formatPyFloat(end),
      step,
    })
    return this.getJson(`${this.endpoint}/api/v1/query_range?${params.toString()}`)
  }

  /**
   * GET `/api/v1/rules` (alerting and recording rules with current state).
   * @returns the raw parsed Prometheus response envelope.
   */
  async rules(): Promise<unknown> {
    return this.getJson(`${this.endpoint}/api/v1/rules`)
  }
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
