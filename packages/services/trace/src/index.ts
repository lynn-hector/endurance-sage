/**
 * Trace query client (Grafana-Jaeger datasource / Jaeger native) as a Cordis
 * service.
 *
 * Port of the transport + parsing half of the original
 * `skills/trace-analyzer/scripts/fetch_traces.py`: Grafana `/login` session
 * bootstrap, `/api/ds/query` trace fetch with one auth retry, and the
 * conservative frame parser that keeps `raw_response` when the shape is
 * unrecognized. Error messages keep the original Chinese wording
 * (`Grafana 登录失败 HTTP ...`, `Grafana query 连接失败: ...`).
 *
 * Deliberate deviations from the script era (also listed in the porting
 * report):
 * - Session cache: the script persisted `grafana_session` through
 *   `skills/lib/auth_cache.py` at `~/.endurance-sentry/auth/{env}.json`. This
 *   service uses the shared in-memory `GrafanaSessionKeeper`
 *   (`@dsh-sentry/datasource`, same 24h default TTL — also used by
 *   service-prometheus/service-alertmanager) and re-logs-in after a process
 *   restart — nothing touches the disk. The auth retry judges structured
 *   HTTP status (401/403) via `isAuthFailureError`, never message text.
 * - `mode: 'jaeger'` (Jaeger native HTTP API, bearer token) is NEW code: the
 *   Python script only implemented the Grafana path and would have crashed on
 *   the production config (`type: jaeger`, token-only credentials). This
 *   service fills that gap with `GET {endpoint}/api/traces/{traceId}`.
 * - Non-JSON query responses raise a wrapped error instead of the raw
 *   `json.loads` traceback (same pattern as `service-greptimedb`).
 * - Credentials resolve per call via `resolveCredential`, so a hot-reloaded
 *   credential plane takes effect without restarting; the session cache only
 *   ever holds the cookie, never the credentials.
 *
 * @module @dsh-sentry/service-trace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  credentialRefField,
  endpointField,
  GrafanaSessionKeeper,
  HttpError,
  isAuthFailureError,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

const GRAFANA_LOGIN_PATH = '/login'
const GRAFANA_QUERY_PATH = '/api/ds/query'
const SESSION_COOKIE = 'grafana_session'

/** Original `auth_cache._DEFAULT_TTL_HOURS` (24h) expressed in milliseconds. */
const DEFAULT_SESSION_TTL_MS = 24 * 3600 * 1000

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /**
   * Query mode, from the original `traces.type` config field:
   * - `grafana-jaeger` (default): Grafana-proxied Jaeger datasource
   *   (local/staging); logs in via `/login` and queries `/api/ds/query`.
   * - `jaeger`: Jaeger native HTTP API (production); bearer-token
   *   `GET /api/traces/{traceId}`.
   */
  mode?: 'grafana-jaeger' | 'jaeger'
  /** Grafana base URL, or Jaeger query-service base URL in `jaeger` mode. */
  endpoint: string
  /** Credential reference for the Grafana login username, e.g. `GRAFANA_LOCAL_USERNAME`. */
  usernameRef?: string
  /** Credential reference for the Grafana login password, e.g. `GRAFANA_LOCAL_PASSWORD`. */
  passwordRef?: string
  /** Credential reference for the Jaeger native bearer token, e.g. `JAEGER_PRODUCTION_TOKEN`. */
  tokenRef?: string
  /** Literal username fallback when no reference is configured. Discouraged in composition files. */
  username?: string
  /** Literal password fallback when no reference is configured. Discouraged in composition files. */
  password?: string
  /** Literal bearer-token fallback when no reference is configured. Discouraged in composition files. */
  token?: string
  /** Per-request timeout in milliseconds. Defaults to 30000 (the original script's timeout). */
  timeoutMs?: number
  /**
   * In-memory session TTL in milliseconds. Defaults to 24h, matching
   * `auth_cache._DEFAULT_TTL_HOURS`.
   */
  sessionTtlMs?: number
}

/** Parameters of one trace query (the original script's per-run arguments). */
export interface QueryTraceParams {
  /** traceId / requestId, aligned with the `trace_id` field in logs. */
  traceId: string
  /** Range start: ISO8601 or `now-1h` / `now-30m` / `now-1d`. Defaults to `now-1h`. */
  start?: string
  /** Range end: ISO8601 or `now`. Defaults to `now`. */
  end?: string
  /** Search mode: service name (reserved pass-through, single string). */
  service?: string
  /** Search mode: operation name (reserved pass-through, single string). */
  operation?: string
  /** Grafana datasource uid (grafana-jaeger mode; from tool plugin Config). */
  datasourceUid?: string
  /** Grafana numeric datasource id override (grafana-jaeger mode). */
  datasourceId?: number
}

/** One Jaeger tag as carried in Grafana frames (`{key, value, ...}`). */
export interface TraceTag {
  key?: unknown
  value?: unknown
}

/** One analyzed span; field names keep the original snake_case contract. */
export interface TraceSpan {
  span_id: unknown
  parent_id: unknown
  operation: unknown
  service: unknown
  start_time: unknown
  duration_ms: number
  tags: TraceTag[]
  stack_traces: unknown
  status: 'ok' | 'error'
}

/** Parsed trace analysis, mirroring `_parse_trace_response`'s result dict. */
export interface ParsedTrace {
  duration_ms: number
  status: 'ok' | 'error' | 'unknown'
  services: string[]
  spans: TraceSpan[]
  /** Top-5 slowest spans with duration > 100ms. */
  slow_spans: TraceSpan[]
  /** Spans whose status is `error`. */
  errors: TraceSpan[]
  frames_count: number
  /** Original response, kept when the structure is unrecognized. */
  raw_response?: unknown
}

/** A built HTTP request, ready for `fetch`; headers as a plain record. */
export interface BuiltRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Port of `_parse_time`: ISO8601 or `now[-Nh|Nm|Nd]` to epoch milliseconds.
 * Empty/undefined input yields 0, exactly like the script. `nowMs` is
 * injectable for tests; anything `now…` that does not match the relative
 * grammar falls back to the current time, as the original did.
 */
export function parseTraceTime(value?: string, nowMs: number = Date.now()): number {
  if (!value) return 0
  const trimmed = value.trim()

  if (trimmed.startsWith('now')) {
    const match = /^now-(\d+)([hmd])$/.exec(trimmed)
    if (!match) return nowMs
    const num = Number(match[1])
    const unit = match[2]
    const seconds = unit === 'h' ? num * 3600 : unit === 'm' ? num * 60 : num * 86400
    return nowMs - seconds * 1000
  }

  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) {
    // The script crashed with a ValueError from datetime.fromisoformat; a
    // service must name its failure instead.
    throw new Error(`无法解析时间表达式: ${value}`)
  }
  return ms
}

/**
 * Port of `_login`'s request construction, verbatim: URL uses the rstripped
 * endpoint while `origin`/`referer` keep the raw configured value.
 */
export function buildGrafanaLoginRequest(endpoint: string, username: string, password: string): BuiltRequest {
  return {
    url: `${endpoint.replace(/\/+$/, '')}${GRAFANA_LOGIN_PATH}`,
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: endpoint,
      referer: `${endpoint}/login`,
    },
    body: JSON.stringify({ user: username, password }),
  }
}

/**
 * Port of `_query_trace`'s request construction, verbatim: query string
 * (`ds_type=jaeger&requestId=trace_{traceId}`, unencoded as in the script),
 * the eight header fields, and the body with `from`/`to` as decimal strings.
 * `datasourceId` is added only when truthy, matching `if datasource_id:`.
 */
export function buildGrafanaQueryRequest(options: {
  endpoint: string
  datasourceUid: string
  datasourceId?: number
  session: string
  traceId: string
  startMs: number
  endMs: number
  service: string
  operation: string
}): BuiltRequest {
  const { endpoint, datasourceUid, session, traceId } = options
  const queryPayload: Record<string, unknown> = {
    refId: 'A',
    datasource: { type: 'jaeger', uid: datasourceUid },
    query: traceId,
    service: options.service,
    operation: options.operation,
    minDuration: '',
    maxDuration: '',
  }
  if (options.datasourceId) {
    queryPayload['datasourceId'] = options.datasourceId
  }
  return {
    url: `${endpoint.replace(/\/+$/, '')}${GRAFANA_QUERY_PATH}?ds_type=jaeger&requestId=trace_${traceId}`,
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: endpoint,
      referer: `${endpoint}/explore`,
      'x-datasource-uid': datasourceUid,
      'x-plugin-id': 'jaeger',
      'x-grafana-org-id': '1',
      cookie: `${SESSION_COOKIE}=${session}`,
    },
    body: JSON.stringify({
      queries: [queryPayload],
      from: String(options.startMs),
      to: String(options.endMs),
    }),
  }
}

/** Jaeger native request (new code; no Python counterpart — see module doc). */
export function buildJaegerQueryRequest(endpoint: string, token: string, traceId: string): BuiltRequest {
  return {
    url: `${endpoint.replace(/\/+$/, '')}/api/traces/${encodeURIComponent(traceId)}`,
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  }
}

/** First tag in the list whose `key` matches; `undefined` when absent. */
function tagValue(tags: TraceTag[] | undefined, key: string): unknown {
  for (const tag of tags ?? []) {
    if (tag?.key === key) return tag.value
  }
  return undefined
}

/** `int(x)` with Python semantics: truncates floats, rejects non-integral strings. */
function toPythonInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return undefined
}

/** Port of `_span_status`. */
export function spanStatus(span: { tags?: TraceTag[]; stack_traces?: unknown }): 'ok' | 'error' {
  const tags = span.tags ?? []

  const statusCode = tagValue(tags, 'http.response.status_code')
  if (statusCode !== undefined && statusCode !== null) {
    const code = toPythonInt(statusCode)
    if (code !== undefined && code >= 400) return 'error'
  }

  if (tagValue(tags, 'otel.status_code') === 'ERROR') return 'error'
  // Python `_tag_value(tags, "error") in (True, "true")` uses `==`, so the
  // numeric 1 also matched (`True == 1`); preserved deliberately.
  const errorTag = tagValue(tags, 'error')
  if (errorTag === true || errorTag === 'true' || errorTag === 1) return 'error'
  const stackTraces = span.stack_traces
  if (Array.isArray(stackTraces) ? stackTraces.length > 0 : Boolean(stackTraces)) return 'error'

  return 'ok'
}

/** Shared aggregation tail of `_parse_trace_response` (both modes converge here). */
function finalizeParsedTrace(spans: TraceSpan[]): Omit<ParsedTrace, 'frames_count'> {
  let rootDuration = 0
  for (const span of spans) {
    if (span.parent_id === null || span.parent_id === undefined) {
      rootDuration = span.duration_ms
    }
  }
  const services = [...new Set(
    spans.map(span => span.service).filter((service): service is string => typeof service === 'string' && service.length > 0),
  )].sort()
  const errors = spans.filter(span => span.status === 'error')
  const sortedByDuration = [...spans].sort((a, b) => b.duration_ms - a.duration_ms)
  const slowSpans = sortedByDuration.slice(0, 5).filter(span => span.duration_ms > 100)

  return {
    duration_ms: Math.round(rootDuration * 1000) / 1000,
    status: errors.length > 0 ? 'error' : 'ok',
    services,
    spans,
    slow_spans: slowSpans,
    errors,
  }
}

/** Minimal structural view of the Grafana `/api/ds/query` response. */
interface GrafanaFrame {
  schema?: { fields?: { name?: string }[] }
  data?: { values?: unknown[][] }
}

/**
 * Port of `_parse_trace_response`: conservative parse of the Grafana Jaeger
 * frame; unrecognized shapes keep `raw_response` and return zeroed fields.
 */
export function parseTraceResponse(response: unknown): ParsedTrace {
  const base: ParsedTrace = {
    duration_ms: 0,
    status: 'unknown',
    services: [],
    spans: [],
    slow_spans: [],
    errors: [],
    frames_count: 0,
  }
  if (typeof response !== 'object' || response === null) {
    return { ...base, raw_response: response }
  }

  const results = (response as { results?: Record<string, { frames?: unknown }> }).results ?? {}
  const frames = results['A']?.frames
  if (!frames || !Array.isArray(frames) || frames.length === 0) {
    return { ...base, raw_response: response }
  }
  const framesCount = frames.length

  const frame = frames[0] as GrafanaFrame
  const fields = frame?.schema?.fields ?? []
  const values = frame?.data?.values ?? []
  if (fields.length === 0 || values.length === 0) {
    return { ...base, frames_count: framesCount, raw_response: response }
  }

  const fieldNames = fields.map(field => field?.name)
  const rowCount = values[0]?.length ?? 0

  const spans: TraceSpan[] = []
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {}
    for (const [idx, name] of fieldNames.entries()) {
      row[String(name)] = idx < values.length ? values[idx]?.[i] ?? null : null
    }
    const rawDuration = row['duration']
    const durationMs = typeof rawDuration === 'number' ? rawDuration : Number(rawDuration ?? 0) || 0
    const rawTags = row['tags']
    const rawStackTraces = row['stackTraces']
    const span: TraceSpan = {
      span_id: row['spanID'] ?? null,
      parent_id: row['parentSpanID'] ?? null,
      operation: row['operationName'] ?? null,
      service: row['serviceName'] ?? null,
      start_time: row['startTime'] ?? null,
      duration_ms: durationMs,
      tags: Array.isArray(rawTags) ? rawTags as TraceTag[] : [],
      // Python `row.get("stackTraces") or None`: empty arrays collapse to null.
      stack_traces: Array.isArray(rawStackTraces) && rawStackTraces.length === 0
        ? null
        : rawStackTraces ?? null,
      status: 'ok',
    }
    span.status = spanStatus(span)
    spans.push(span)
  }

  return { ...finalizeParsedTrace(spans), frames_count: framesCount }
}

/** Minimal structural view of the Jaeger native `/api/traces/{id}` response. */
interface JaegerNativeSpan {
  spanID?: string
  operationName?: string
  references?: { refType?: string; spanID?: string }[]
  startTime?: number
  duration?: number
  tags?: TraceTag[]
  processID?: string
}

/**
 * Parse the Jaeger native HTTP API response into the same contract as
 * {@link parseTraceResponse} (new code; no Python counterpart). Durations and
 * start times are microseconds in the native API; `duration_ms` converts,
 * `start_time` passes through raw. `frames_count` carries `data.length`.
 */
export function parseJaegerTraceResponse(response: unknown): ParsedTrace {
  const base: ParsedTrace = {
    duration_ms: 0,
    status: 'unknown',
    services: [],
    spans: [],
    slow_spans: [],
    errors: [],
    frames_count: 0,
  }
  if (typeof response !== 'object' || response === null) {
    return { ...base, raw_response: response }
  }
  const data = (response as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    return { ...base, raw_response: response }
  }

  const spans: TraceSpan[] = []
  for (const entry of data as { spans?: JaegerNativeSpan[]; processes?: Record<string, { serviceName?: string }> }[]) {
    const processes = entry?.processes ?? {}
    for (const raw of entry?.spans ?? []) {
      const childOf = raw.references?.find(ref => ref?.refType === 'CHILD_OF')
      const span: TraceSpan = {
        span_id: raw.spanID ?? null,
        parent_id: childOf?.spanID ?? null,
        operation: raw.operationName ?? null,
        service: (raw.processID !== undefined ? processes[raw.processID]?.serviceName : undefined) ?? null,
        start_time: raw.startTime ?? null,
        duration_ms: typeof raw.duration === 'number' ? raw.duration / 1000 : 0,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        stack_traces: null,
        status: 'ok',
      }
      span.status = spanStatus(span)
      spans.push(span)
    }
  }

  return { ...finalizeParsedTrace(spans), frames_count: data.length }
}

export class TraceService extends Service {
  static Config: z<Config> = z.object({
    mode: z.union([z.const('grafana-jaeger'), z.const('jaeger')]).default('grafana-jaeger')
      .description('查询模式：grafana-jaeger（Grafana 代理 Jaeger 数据源）或 jaeger（Jaeger 原生 API）'),
    endpoint: endpointField('Grafana 地址，或 jaeger 模式下的 Jaeger query 地址'),
    usernameRef: credentialRefField('Grafana 登录用户名的凭据引用，如 GRAFANA_LOCAL_USERNAME'),
    passwordRef: credentialRefField('Grafana 登录密码的凭据引用，如 GRAFANA_LOCAL_PASSWORD'),
    tokenRef: credentialRefField('Jaeger 原生 API token 的凭据引用，如 JAEGER_PRODUCTION_TOKEN'),
    username: secretField('内联用户名（credential ref 优先；不推荐写在组合文件）'),
    password: secretField('内联密码（credential ref 优先；不推荐写在组合文件）'),
    token: secretField('内联 token（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
    sessionTtlMs: z.number().step(1).min(1).default(DEFAULT_SESSION_TTL_MS)
      .description('grafana_session 内存缓存 TTL（毫秒），默认 24 小时'),
  })

  /** Configured endpoint with trailing slashes stripped, for evidence metadata. */
  readonly endpoint: string
  private readonly mode: 'grafana-jaeger' | 'jaeger'
  private readonly timeoutMs: number
  private readonly sessionTtlMs: number
  private readonly config: Config
  /** Shared form-login session keeper (`@dsh-sentry/datasource`). */
  private readonly keeper: GrafanaSessionKeeper

  constructor(ctx: Context, config: Config = { endpoint: '' }) {
    super(ctx, 'trace')
    // The schema already defaulted optional fields under the Loader; the ??
    // narrows the type for direct (non-Loader) construction in tests.
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.mode = config.mode ?? 'grafana-jaeger'
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.config = config
    this.keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: this.endpoint,
      resolveCredentials: () => this.credentials(),
      timeoutMs: this.timeoutMs,
      sessionTtlMs: this.sessionTtlMs,
    })
    // The session is in-memory and dies with the fiber anyway; dropping it on
    // teardown just keeps a reloaded plugin from holding a stale cookie.
    ctx.effect(() => () => this.keeper.clearSession())
  }

  /** Resolve Grafana login credentials: references win over literal fallbacks. */
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
    if (this.endpoint.length === 0) {
      throw new Error('traces.endpoint 缺失，请检查插件配置')
    }
    if (!username || !password) {
      throw new Error('traces 凭据缺失，需要 username/password 或凭据引用注入')
    }
    return { username, password }
  }

  /** Resolve the Jaeger native bearer token: reference wins over the literal. */
  private async bearerToken(): Promise<string> {
    let token: string | undefined
    if (this.config.tokenRef !== undefined) {
      token = await resolveCredential(this.ctx, this.config.tokenRef)
    }
    token ??= this.config.token
    if (this.endpoint.length === 0) {
      throw new Error('traces.endpoint 缺失，请检查插件配置')
    }
    if (!token) {
      throw new Error('traces.token 缺失，需要 token 或凭据引用注入')
    }
    return token
  }

  /** Port of `_query_trace`'s network half; parsing lives in {@link parseTraceResponse}. */
  private async queryViaGrafana(options: {
    datasourceUid: string
    datasourceId?: number
    session: string
    traceId: string
    startMs: number
    endMs: number
    service: string
    operation: string
  }): Promise<unknown> {
    const request = buildGrafanaQueryRequest({ endpoint: this.endpoint, ...options })
    let resp: Response
    try {
      resp = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ?? null,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`Grafana query 连接失败: ${errorMessage(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new HttpError(`Grafana query HTTP ${resp.status}: ${detail}`, resp.status)
    }
    try {
      return await resp.json()
    } catch (cause) {
      // The script crashed with a raw JSONDecodeError here; wrapped instead,
      // matching service-greptimedb's convention.
      throw new Error(`Grafana query 响应不是合法 JSON: ${errorMessage(cause)}`)
    }
  }

  /** Jaeger native fetch (new code; no Python counterpart — see module doc). */
  private async queryViaJaeger(token: string, traceId: string): Promise<unknown> {
    const request = buildJaegerQueryRequest(this.endpoint, token, traceId)
    let resp: Response
    try {
      resp = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`Jaeger query 连接失败: ${errorMessage(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`Jaeger query HTTP ${resp.status}: ${detail}`)
    }
    try {
      return await resp.json()
    } catch (cause) {
      throw new Error(`Jaeger query 响应不是合法 JSON: ${errorMessage(cause)}`)
    }
  }

  /**
   * Query one trace by id and return the parsed analysis.
   *
   * grafana-jaeger mode ports `_main`'s session flow: cached session → query;
   * on a 401/403-looking failure the session is dropped, refreshed once via
   * `/login`, and the query retried exactly once. jaeger mode is a single
   * bearer-token GET with no retry (a rejected token cannot fix itself).
   *
   * In jaeger mode `start`/`end` are accepted but unused: the native
   * `/api/traces/{traceId}` endpoint has no time-range parameters.
   */
  async queryTrace(params: QueryTraceParams): Promise<ParsedTrace> {
    if (this.mode === 'jaeger') {
      const token = await this.bearerToken()
      const response = await this.queryViaJaeger(token, params.traceId)
      return parseJaegerTraceResponse(response)
    }

    const datasourceUid = params.datasourceUid ?? ''
    if (!datasourceUid) {
      throw new Error('traces.datasource_uid 缺失，请检查插件配置')
    }

    const nowMs = Date.now()
    // Python `... if args.start else now_ms - 3600_000`: empty strings take the default too.
    const startMs = params.start ? parseTraceTime(params.start, nowMs) : nowMs - 3600_000
    const endMs = params.end ? parseTraceTime(params.end, nowMs) : nowMs

    const queryOptions = (session: string) => ({
      datasourceUid,
      ...params.datasourceId !== undefined ? { datasourceId: params.datasourceId } : {},
      session,
      traceId: params.traceId,
      startMs,
      endMs,
      service: params.service ?? '',
      operation: params.operation ?? '',
    })

    // 会话由共享 keeper 管理（缓存/过期/单飞登录）；凭据校验错误从 authSession 冒出
    const auth = await this.keeper.authSession()
    if (auth.session === undefined) {
      throw new Error('traces 凭据缺失，需要 username/password 或凭据引用注入')
    }

    try {
      const response = await this.queryViaGrafana(queryOptions(auth.session))
      return parseTraceResponse(response)
    } catch (error) {
      if (!auth.retriable || !isAuthFailureError(error)) throw error
      this.keeper.clearSession()
      const refreshed = await this.keeper.authSession()
      if (refreshed.session === undefined) {
        throw new Error('traces 凭据缺失，需要 username/password 或凭据引用注入')
      }
      const response = await this.queryViaGrafana(queryOptions(refreshed.session))
      return parseTraceResponse(response)
    }
  }

  /**
   * Build the would-be request without sending it — the original `--dry-run`
   * mode. grafana-jaeger mode masks the session cookie exactly like the
   * script's dry-run output (`grafana_session=...`); jaeger mode masks the
   * bearer token. Unlike the script's dry-run, the preview URL includes the
   * query string actually used (the original printed a bare path).
   */
  async buildQueryPreview(params: QueryTraceParams): Promise<Record<string, unknown>> {
    const nowMs = Date.now()
    const startMs = params.start ? parseTraceTime(params.start, nowMs) : nowMs - 3600_000
    const endMs = params.end ? parseTraceTime(params.end, nowMs) : nowMs

    if (this.mode === 'jaeger') {
      return {
        url: `${this.endpoint}/api/traces/${encodeURIComponent(params.traceId)}`,
        headers: { authorization: 'Bearer ...' },
        body: null,
      }
    }

    const datasourceUid = params.datasourceUid ?? ''
    if (!datasourceUid) {
      throw new Error('traces.datasource_uid 缺失，请检查插件配置')
    }
    const request = buildGrafanaQueryRequest({
      endpoint: this.endpoint,
      datasourceUid,
      ...params.datasourceId !== undefined ? { datasourceId: params.datasourceId } : {},
      session: '...',
      traceId: params.traceId,
      startMs,
      endMs,
      service: params.service ?? '',
      operation: params.operation ?? '',
    })
    return {
      url: request.url,
      headers: { cookie: `${SESSION_COOKIE}=...` },
      body: request.body !== undefined ? JSON.parse(request.body) as unknown : null,
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    trace: TraceService
  }
}

export default TraceService
