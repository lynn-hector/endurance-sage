/**
 * Grafana form-login session keeper + auth-retry request helpers, shared by
 * the services that talk to Grafana-hosted datasources (service-prometheus
 * proxy mode, service-alertmanager). Services still carrying a private
 * copy of this mechanism should migrate here.
 *
 * @module @dsh-sentry/datasource/grafana-session
 */

const SESSION_COOKIE = 'grafana_session'
const DEFAULT_SESSION_TTL_MS = 24 * 3600 * 1000

/** Constructor options; `resolveCredentials` returns undefined for anonymous. */
export interface GrafanaSessionKeeperOptions {
  grafanaEndpoint: string
  resolveCredentials: () => Promise<{ username: string; password: string } | undefined>
  timeoutMs?: number
  sessionTtlMs?: number
}

export class GrafanaSessionKeeper {
  private readonly grafanaEndpoint: string
  private readonly options: GrafanaSessionKeeperOptions
  private session: { value: string; expiresAt: number } | undefined
  private loginFlight: Promise<string> | null = null

  constructor(options: GrafanaSessionKeeperOptions) {
    this.grafanaEndpoint = options.grafanaEndpoint.replace(/\/+$/, '')
    this.options = options
  }

  /**
   * Session-cookie auth headers. With credentials: one single-flight form
   * login buys a cached `grafana_session` (`retriable: true` — a rejected
   * session can heal with a fresh login). Without credentials: anonymous,
   * `retriable: false`.
   */
  async authHeaders(): Promise<{ headers: Record<string, string>; retriable: boolean }> {
    const { session, retriable } = await this.authSession()
    return { headers: session === undefined ? {} : { cookie: `${SESSION_COOKIE}=${session}` }, retriable }
  }

  /**
   * Raw session value, for consumers that build their own cookie headers
   * (service-trace's per-request contract shape). Same semantics as
   * {@link authHeaders}: `retriable: true` only with credentials.
   */
  async authSession(): Promise<{ session: string | undefined; retriable: boolean }> {
    const credentials = await this.options.resolveCredentials()
    if (credentials === undefined) return { session: undefined, retriable: false }
    return { session: await this.ensureSession(credentials), retriable: true }
  }

  clearSession(): void {
    this.session = undefined
  }

  private loadSession(): string | undefined {
    if (this.session === undefined) return undefined
    if (Date.now() > this.session.expiresAt) {
      this.session = undefined
      return undefined
    }
    return this.session.value
  }

  private async login(username: string, password: string): Promise<string> {
    const timeoutMs = this.options.timeoutMs ?? 30_000
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
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new Error(`Grafana 登录连接失败: ${cause instanceof Error ? cause.message : String(cause)}`)
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

  private async ensureSession(credentials: { username: string; password: string }): Promise<string> {
    const cached = this.loadSession()
    if (cached !== undefined) return cached
    const ttl = this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.loginFlight ??= this.login(credentials.username, credentials.password)
      .then((session) => {
        this.session = { value: session, expiresAt: Date.now() + ttl }
        return session
      })
      .finally(() => {
        this.loginFlight = null
      })
    return this.loginFlight
  }
}

/** Extract a cookie value from `Set-Cookie` response headers: the first
 *  `Set-Cookie` whose name matches wins. Generic helper shared by every
 *  cookie-session service (grafana legs, dbx, rocketmq). */
export function extractCookie(headers: Headers, name: string): string | undefined {
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

/**
 * HTTP 非 2xx 错误，携带结构化状态码——重试判定读 `status`，**不解析消息文本**
 * （消息里的 detail 可能嵌着任意 "401"/"403" 数字串：epoch 毫秒、request id，
 * 子串匹配会把服务端 5xx 误判为会话失效，丢健康会话并搅动登录）。
 */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** 会话失效判定：仅结构化 401/403。 */
export function isAuthFailureError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403)
}

/** 经 Grafana 会话的 GET JSON：401/403 时清会话重登一次再重试。
 *  Grafana 代理型服务（prometheus、alertmanager）的统一调用形状；label 进错误
 *  文案（如 'Alertmanager HTTP 500'），保持各服务原有报错口径。 */
export async function authRetryGetJson(
  keeper: GrafanaSessionKeeper,
  url: string,
  options: { timeoutMs?: number; label: string },
): Promise<unknown> {
  const auth = await keeper.authHeaders()
  try {
    return await fetchGetJson(url, auth.headers, options)
  } catch (error) {
    if (!auth.retriable || !isAuthFailureError(error)) throw error
    keeper.clearSession()
    const retry = await keeper.authHeaders()
    return fetchGetJson(url, retry.headers, options)
  }
}

async function fetchGetJson(
  url: string,
  authHeaders: Record<string, string>,
  options: { timeoutMs?: number; label: string },
): Promise<unknown> {
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    })
  } catch (cause) {
    throw new Error(`请求 ${options.label} 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!resp.ok) {
    const detail = await resp.text()
    throw new HttpError(`${options.label} HTTP ${resp.status}: ${detail}`, resp.status)
  }
  try {
    return await resp.json()
  } catch (cause) {
    throw new Error(`请求 ${options.label} 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
