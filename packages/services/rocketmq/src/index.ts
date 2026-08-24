/**
 * RocketMQ Console client as a Cordis service.
 *
 * Port of the transport + session half of the original
 * `skills/mq-inspector/scripts/inspect.py`: `/login/login.do` (JSON body,
 * XSRF-TOKEN cookie and header must match, JSESSIONID extracted from
 * Set-Cookie), session validation via `/topic/list.query` (`status === 0`),
 * message list via POST `/message/queryMessagePageByTopic.query`, and
 * message detail via GET `/message/viewMessage.query`. Queries retry once
 * through a fresh login on 401/403 (`_query_with_fallback` /
 * `_query_detail_with_fallback`).
 *
 * Deliberate deviations from the script era:
 * - the disk auth cache (`~/.endurance-sentry/auth/{env}.json`) is gone —
 *   the session lives in the service instance and re-logins on demand,
 *   like every other ported service;
 * - `urllib` is replaced by `fetch`; HTTP errors and network failures are
 *   uniformly wrapped as `请求 RocketMQ Console 失败: ...`;
 * - `config/{env}.yml` `datasources.mq` (`console_endpoint` fallback to
 *   `endpoint`, etc.) collapsed into plugin Config with a single
 *   HTTP endpoint validated by the schema (the nameserver-address case
 *   the script rejected at runtime);
 * - concurrent session acquisition is single-flight.
 *
 * @module @dsh-sentry/service-rocketmq
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

const PATH_LOGIN = '/login/login.do'
const PATH_CHECK = '/topic/list.query'
const PATH_LIST = '/message/queryMessagePageByTopic.query'
const PATH_DETAIL = '/message/viewMessage.query'

const BASE_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9',
  priority: 'u=1, i',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
}

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** RocketMQ Console base URL (must be http(s), not a nameserver address). */
  endpoint: string
  /** Console login username (the original `console_username` fallback `username`). */
  username?: string
  /** Credential reference for the console username, e.g. `ROCKETMQ_LOCAL_USERNAME`. Wins over the literal. */
  usernameRef?: string
  /** Credential reference for the console login password, e.g. `ROCKETMQ_CONSOLE_PASSWORD`. */
  passwordRef?: string
  /** Literal password fallback when no reference is configured. Discouraged in composition files. */
  password?: string
  /** Per-request timeout in milliseconds. Defaults to 30000 (the script's urllib timeout). */
  timeoutMs?: number
}

/** One row of the message-list page content, kept raw for the evidence layer. */
export type MqMessageRow = Record<string, unknown>

/** Aggregate of the console list response the tool layer shapes into evidence. */
export interface MqMessageListResult {
  status: unknown
  errMsg: string | null
  taskId: unknown
  truncated: boolean
  scanned: number
  totalElements: number | null
  totalPages: number | null
  messages: MqMessageRow[]
  raw: Record<string, unknown>
}

/** Aggregate of the console detail response the tool layer shapes into evidence. */
export interface MqMessageDetailResult {
  status: unknown
  errMsg: string | null
  messageView: Record<string, unknown>
  messageTrackList: Record<string, unknown>[]
  raw: Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}

/** Active console session: the JSESSIONID cookie plus its matching XSRF token. */
interface ConsoleSession {
  jsessionid: string
  xsrfToken: string
}

/** Input of {@link RocketMqService.queryMessages}; times are epoch ms. */
export interface QueryMessagesInput {
  topic: string
  beginMs: number
  endMs: number
  pageNum?: number
  pageSize?: number
  keyword?: string
}

/**
 * RocketMQ Console client with cached-session auth and 401/403 re-login.
 */
export class RocketMqService extends Service {
  static Config: z<Config> = z.object({
    endpoint: endpointField('RocketMQ Console 地址，如 https://rocketmq.cn-0.dev.novo-one.com（必须是 http(s) URL）'),
    username: z.string().description('Console 登录用户名（原 mq.console_username；usernameRef 优先）'),
    usernameRef: credentialRefField('Console 用户名的凭据引用，如 ROCKETMQ_LOCAL_USERNAME'),
    passwordRef: credentialRefField('Console 登录密码的凭据引用，如 ROCKETMQ_CONSOLE_PASSWORD'),
    password: secretField('内联登录密码（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
  })

  /** Configured console base URL with trailing slashes stripped, for evidence metadata. */
  readonly endpoint: string
  private readonly config: Config
  private readonly timeoutMs: number
  private session: ConsoleSession | null = null
  private loginFlight: Promise<ConsoleSession> | null = null

  constructor(ctx: Context, config: Config = { endpoint: '', username: '' }) {
    super(ctx, 'rocketmq')
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.config = config
  }

  /** Resolve the console password: reference wins over the literal fallback. */
  private async resolvePassword(): Promise<string | undefined> {
    let password: string | undefined
    if (this.config.passwordRef !== undefined) {
      password = await resolveCredential(this.ctx, this.config.passwordRef)
    }
    password ??= this.config.password
    return password
  }

  /** Original `_extract_cookie`: pull one cookie value out of Set-Cookie headers. */
  private extractCookie(resp: Response, name: string): string | null {
    const raw = resp.headers.getSetCookie?.() ?? []
    for (const cookie of raw) {
      if (cookie.startsWith(`${name}=`)) {
        return cookie.split(';', 1)[0]?.split('=', 2)[1] ?? null
      }
    }
    return null
  }

  /** Original `_build_cookie`. */
  private buildCookie(jsessionid: string | null, xsrfToken: string): string {
    const parts = [`XSRF-TOKEN=${xsrfToken}`]
    if (jsessionid) parts.push(`JSESSIONID=${jsessionid}`)
    return parts.join('; ')
  }

  /** Original `_console_request`: browser-ish headers + matching XSRF cookie/header. */
  private async consoleRequest(
    path: string,
    options: {
      method?: string
      body?: string
      session?: ConsoleSession | null
    } = {},
  ): Promise<Record<string, unknown>> {
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { ...BASE_HEADERS }
    headers['origin'] = this.endpoint
    headers['referer'] = `${this.endpoint}/`
    if (options.body !== undefined) headers['content-type'] = 'application/json'

    const xsrf = options.session?.xsrfToken ?? randomUuid()
    headers['x-xsrf-token'] = xsrf
    headers['cookie'] = this.buildCookie(options.session?.jsessionid ?? null, xsrf)

    let resp: Response
    try {
      resp = await fetch(`${this.endpoint}${path}`, {
        method,
        headers,
        body: options.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`请求 RocketMQ Console 连接失败: ${errorMessage(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`RocketMQ Console HTTP ${resp.status}: ${detail}`)
    }
    try {
      const parsed = await resp.json()
      return isRecord(parsed) ? parsed : {}
    } catch (cause) {
      throw new Error(`请求 RocketMQ Console 失败: ${errorMessage(cause)}`)
    }
  }

  /** Original `_login`: POST credentials, keep the XSRF token paired with the returned JSESSIONID. */
  /** Resolve the console username: reference wins over the literal. */
  private async resolveUsername(): Promise<string> {
    if (this.config.usernameRef !== undefined) {
      const resolved = await resolveCredential(this.ctx, this.config.usernameRef)
      if (resolved !== undefined && resolved.length > 0) return resolved
    }
    return this.config.username ?? ''
  }

  private async login(): Promise<ConsoleSession> {
    const password = await this.resolvePassword()
    const username = await this.resolveUsername()
    if (this.endpoint.length === 0 || username.length === 0 || !password) {
      throw new Error('RocketMQ Console endpoint/用户名/密码 未配置完整')
    }

    const xsrfToken = randomUuid()
    let resp: Response
    try {
      resp = await fetch(`${this.endpoint}${PATH_LOGIN}`, {
        method: 'POST',
        headers: {
          ...BASE_HEADERS,
          origin: this.endpoint,
          referer: `${this.endpoint}/`,
          'content-type': 'application/json',
          'x-xsrf-token': xsrfToken,
          cookie: `XSRF-TOKEN=${xsrfToken}`,
        },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`RocketMQ Console 登录连接失败: ${errorMessage(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`RocketMQ Console 登录失败 HTTP ${resp.status}: ${detail}`)
    }
    const jsessionid = this.extractCookie(resp, 'JSESSIONID')
    if (!jsessionid) {
      throw new Error(`登录成功但未返回 JSESSIONID cookie，响应: ${(await resp.text()).slice(0, 200)}`)
    }
    return { jsessionid, xsrfToken }
  }

  /** Single-flight login: concurrent callers share one flight. */
  private async loginSingleFlight(): Promise<ConsoleSession> {
    if (this.loginFlight) return this.loginFlight
    const flight = this.login().finally(() => {
      if (this.loginFlight === flight) this.loginFlight = null
    })
    this.loginFlight = flight
    return flight
  }

  /** Original `_check_session`: `/topic/list.query` answers `status === 0`. */
  private async checkSession(session: ConsoleSession): Promise<boolean> {
    try {
      const resp = await this.consoleRequest(PATH_CHECK, { session })
      return resp['status'] === 0
    } catch (error) {
      const text = errorMessage(error)
      if (text.includes('401') || text.includes('403')) return false
      throw error
    }
  }

  /** Original `_ensure_session`: cached session when valid, otherwise a fresh login. */
  async ensureSession(): Promise<ConsoleSession> {
    if (this.session && await this.checkSession(this.session)) return this.session
    this.session = await this.loginSingleFlight()
    return this.session
  }

  /** True when an error text means "session expired" (the original 401/403 match). */
  private isAuthError(error: unknown): boolean {
    const text = errorMessage(error)
    return text.includes('401') || text.includes('403')
  }

  /** Original `_query_with_fallback`: query, re-login once on 401/403, retry. */
  private async withSessionRetry<T>(fn: (session: ConsoleSession) => Promise<T>): Promise<T> {
    let session = await this.ensureSession()
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(session)
      } catch (error) {
        if (attempt === 0 && this.isAuthError(error)) {
          session = await this.loginSingleFlight()
          this.session = session
          continue
        }
        throw error
      }
    }
  }

  /** Original `_parse_time_ms`: pure-digit milliseconds or ISO8601 → epoch ms. */
  static parseTimeMs(value: string | number | undefined | null, defaultMs?: number): number {
    if (value === undefined || value === null || value === '') {
      return defaultMs ?? Date.now()
    }
    const text = String(value).trim()
    if (/^\d+$/.test(text)) return Number(text)
    const normalized = text.endsWith('Z') ? text : `${text}Z`
    const dt = new Date(normalized)
    if (Number.isNaN(dt.getTime())) {
      throw new Error(`无法解析时间参数: ${text}`)
    }
    return dt.getTime()
  }

  /** Constructed list request body + URL, for dry-run evidence. */
  buildListRequest(input: QueryMessagesInput): { url: string; body: Record<string, unknown> } {
    return {
      url: `${this.endpoint}${PATH_LIST}`,
      body: {
        topic: input.topic,
        begin: input.beginMs,
        end: input.endMs,
        pageNum: input.pageNum ?? 1,
        pageSize: input.pageSize ?? 10,
        taskId: '',
        keyword: input.keyword ?? '',
      },
    }
  }

  /** Constructed detail request URL, for dry-run evidence. */
  buildDetailRequest(topic: string, msgId: string): { url: string } {
    return {
      url: `${this.endpoint}${PATH_DETAIL}?msgId=${encodeURIComponent(msgId)}&topic=${encodeURIComponent(topic)}`,
    }
  }

  /**
   * Port of `_query_messages` + list aggregation from `_build_evidence`:
   * page content, totals, task state, raw response.
   */
  async queryMessages(input: QueryMessagesInput): Promise<MqMessageListResult> {
    const { body } = this.buildListRequest(input)
    const response = await this.withSessionRetry(session =>
      this.consoleRequest(PATH_LIST, { method: 'POST', body: JSON.stringify(body), session }),
    )

    const data = isRecord(response['data']) ? response['data'] : {}
    const page = isRecord(data['page']) ? data['page'] : {}
    const messages = Array.isArray(page['content']) ? page['content'] as MqMessageRow[] : []

    return {
      status: response['status'],
      errMsg: typeof response['errMsg'] === 'string' ? response['errMsg'] : null,
      taskId: data['taskId'],
      truncated: data['truncated'] === true,
      scanned: typeof data['scanned'] === 'number' ? data['scanned'] : 0,
      totalElements: typeof page['totalElements'] === 'number' ? page['totalElements'] : null,
      totalPages: typeof page['totalPages'] === 'number' ? page['totalPages'] : null,
      messages,
      raw: response,
    }
  }

  /**
   * Port of `_query_message_detail` + detail aggregation from
   * `_build_evidence`: message view and consumption tracks.
   */
  async queryMessageDetail(topic: string, msgId: string): Promise<MqMessageDetailResult> {
    const response = await this.withSessionRetry(session =>
      this.consoleRequest(
        `${PATH_DETAIL}?msgId=${encodeURIComponent(msgId)}&topic=${encodeURIComponent(topic)}`,
        { session },
      ),
    )

    const data = isRecord(response['data']) ? response['data'] : {}
    return {
      status: response['status'],
      errMsg: typeof response['errMsg'] === 'string' ? response['errMsg'] : null,
      messageView: isRecord(data['messageView']) ? data['messageView'] : {},
      messageTrackList: Array.isArray(data['messageTrackList'])
        ? data['messageTrackList'].filter(isRecord)
        : [],
      raw: response,
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    rocketmq: RocketMqService
  }
}

export default RocketMqService
