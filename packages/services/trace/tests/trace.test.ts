import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TraceService,
  buildGrafanaLoginRequest,
  buildGrafanaQueryRequest,
  buildJaegerQueryRequest,
  parseJaegerTraceResponse,
  parseTraceResponse,
  parseTraceTime,
} from '../src/index.ts'

/**
 * Golden tests: the request shapes asserted here are pinned to the original
 * `skills/trace-analyzer/scripts/fetch_traces.py` string concatenation, field
 * by field. The response fixtures mirror the structure documented in
 * `_parse_trace_response`'s docstring (Grafana dataframe frames).
 */

const GRAFANA = 'https://grafana.example.com'
const JAEGER = 'https://jaeger.example.com'
const TRACE_ID = '63b2cfef8ff31306944652803272c655'

/** Grafana dataframe response fixture with root / slow / error spans. */
const SAMPLE_TRACE_RESPONSE = {
  results: {
    A: {
      frames: [
        {
          schema: {
            fields: [
              { name: 'spanID' },
              { name: 'parentSpanID' },
              { name: 'operationName' },
              { name: 'serviceName' },
              { name: 'startTime' },
              { name: 'duration' },
              { name: 'tags' },
              { name: 'stackTraces' },
            ],
          },
          data: {
            values: [
              ['root-span', 'slow-span', 'err-span'],
              [null, 'root-span', 'root-span'],
              ['GET /api/order', 'db select', 'POST /api/pay'],
              ['gateway', 'orders-db', 'pay-svc'],
              [1723000000000000, 1723000000100000, 1723000000200000],
              [500, 250.5, 80],
              [
                [],
                [],
                [{ key: 'http.response.status_code', value: 500 }],
              ],
              [null, null, null],
            ],
          },
        },
      ],
    },
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Login response carrying (or omitting) the grafana_session Set-Cookie. */
function loginResponse(session: string | undefined, status = 200, body = '{"message":"Logged in"}'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => session !== undefined
        ? [`grafana_session=${session}; Path=/; HttpOnly; SameSite=Lax`]
        : [],
      get: () => null,
    },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response
}

function makeGrafanaService(ctx: Context, extra: Record<string, unknown> = {}): TraceService {
  return new TraceService(ctx, {
    endpoint: GRAFANA,
    usernameRef: 'GRAFANA_TEST_USERNAME',
    passwordRef: 'GRAFANA_TEST_PASSWORD',
    ...extra,
  })
}

describe('parseTraceTime', () => {
  const NOW = 1_800_000_000_000

  it('returns 0 for empty input, exactly like the script', () => {
    expect(parseTraceTime(undefined, NOW)).toBe(0)
    expect(parseTraceTime('', NOW)).toBe(0)
  })

  it('resolves now and relative offsets', () => {
    expect(parseTraceTime('now', NOW)).toBe(NOW)
    expect(parseTraceTime('now-1h', NOW)).toBe(NOW - 3600_000)
    expect(parseTraceTime('now-30m', NOW)).toBe(NOW - 30 * 60_000)
    expect(parseTraceTime('now-2d', NOW)).toBe(NOW - 2 * 86400_000)
  })

  it('falls back to now for unmatched now-expressions, like the script', () => {
    expect(parseTraceTime('now-2w', NOW)).toBe(NOW)
    expect(parseTraceTime('now-', NOW)).toBe(NOW)
  })

  it('parses ISO8601', () => {
    expect(parseTraceTime('2026-07-27T10:00:00Z', NOW)).toBe(Date.parse('2026-07-27T10:00:00Z'))
  })

  it('rejects garbage instead of returning NaN (script raised ValueError)', () => {
    expect(() => parseTraceTime('not-a-time', NOW)).toThrow('无法解析时间表达式')
    // Whitespace-only is truthy in Python and crashed the same way.
    expect(() => parseTraceTime('   ', NOW)).toThrow('无法解析时间表达式')
  })
})

describe('buildGrafanaLoginRequest (golden)', () => {
  it('matches _login field by field', () => {
    const request = buildGrafanaLoginRequest(GRAFANA, 'alice', 's3cret')
    expect(request.url).toBe(`${GRAFANA}/login`)
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual({
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: GRAFANA,
      referer: `${GRAFANA}/login`,
    })
    expect(JSON.parse(request.body!)).toEqual({ user: 'alice', password: 's3cret' })
  })

  it('rstrips the URL endpoint but keeps the raw endpoint in origin/referer', () => {
    const request = buildGrafanaLoginRequest(`${GRAFANA}/`, 'a', 'b')
    expect(request.url).toBe(`${GRAFANA}/login`)
    expect(request.headers['origin']).toBe(`${GRAFANA}/`)
    expect(request.headers['referer']).toBe(`${GRAFANA}//login`)
  })
})

describe('buildGrafanaQueryRequest (golden)', () => {
  const BASE = {
    endpoint: GRAFANA,
    datasourceUid: 'GreptimeDB-Jaeger',
    session: 'SESSION123',
    traceId: TRACE_ID,
    startMs: 1_800_000_000_000,
    endMs: 1_800_000_600_000,
    service: 'gateway',
    operation: 'GET /api/order',
  }

  it('matches _query_trace field by field', () => {
    const request = buildGrafanaQueryRequest(BASE)
    expect(request.url).toBe(
      `${GRAFANA}/api/ds/query?ds_type=jaeger&requestId=trace_${TRACE_ID}`,
    )
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual({
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: GRAFANA,
      referer: `${GRAFANA}/explore`,
      'x-datasource-uid': 'GreptimeDB-Jaeger',
      'x-plugin-id': 'jaeger',
      'x-grafana-org-id': '1',
      cookie: 'grafana_session=SESSION123',
    })
    expect(JSON.parse(request.body!)).toEqual({
      queries: [{
        refId: 'A',
        datasource: { type: 'jaeger', uid: 'GreptimeDB-Jaeger' },
        query: TRACE_ID,
        service: 'gateway',
        operation: 'GET /api/order',
        minDuration: '',
        maxDuration: '',
      }],
      from: '1800000000000',
      to: '1800000600000',
    })
  })

  it('adds datasourceId only when truthy (Python `if datasource_id:`)', () => {
    const withId = JSON.parse(buildGrafanaQueryRequest({ ...BASE, datasourceId: 6 }).body!)
    expect(withId.queries[0].datasourceId).toBe(6)
    const withZero = JSON.parse(buildGrafanaQueryRequest({ ...BASE, datasourceId: 0 }).body!)
    expect('datasourceId' in withZero.queries[0]).toBe(false)
    const without = JSON.parse(buildGrafanaQueryRequest(BASE).body!)
    expect('datasourceId' in without.queries[0]).toBe(false)
  })
})

describe('buildJaegerQueryRequest (golden)', () => {
  it('GETs /api/traces/{traceId} with a bearer token', () => {
    const request = buildJaegerQueryRequest(`${JAEGER}/`, 'tok-1', TRACE_ID)
    expect(request.url).toBe(`${JAEGER}/api/traces/${TRACE_ID}`)
    expect(request.method).toBe('GET')
    expect(request.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer tok-1',
    })
    expect(request.body).toBeUndefined()
  })
})

describe('TraceService.queryTrace (grafana-jaeger)', () => {
  beforeEach(() => {
    vi.stubEnv('GRAFANA_TEST_USERNAME', 'alice')
    vi.stubEnv('GRAFANA_TEST_PASSWORD', 's3cret')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('logs in, queries with the session cookie, and parses the frames', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('SESSION123'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_TRACE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeGrafanaService(new Context())
    const parsed = await service.queryTrace({
      traceId: TRACE_ID,
      datasourceUid: 'GreptimeDB-Jaeger',
      datasourceId: 6,
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T10:30:00Z',
      service: 'gateway',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(loginUrl).toBe(`${GRAFANA}/login`)
    expect(loginInit.method).toBe('POST')
    const [queryUrl, queryInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(queryUrl).toBe(`${GRAFANA}/api/ds/query?ds_type=jaeger&requestId=trace_${TRACE_ID}`)
    const headers = queryInit.headers as Record<string, string>
    expect(headers['cookie']).toBe('grafana_session=SESSION123')
    const body = JSON.parse(queryInit.body as string)
    expect(body.from).toBe(String(Date.parse('2026-07-27T10:00:00Z')))
    expect(body.to).toBe(String(Date.parse('2026-07-27T10:30:00Z')))
    expect(body.queries[0].service).toBe('gateway')
    expect(body.queries[0].datasourceId).toBe(6)

    expect(parsed.status).toBe('error')
    expect(parsed.duration_ms).toBe(500)
    expect(parsed.services).toEqual(['gateway', 'orders-db', 'pay-svc'])
    expect(parsed.spans).toHaveLength(3)
    expect(parsed.errors.map(span => span.span_id)).toEqual(['err-span'])
    // The Python keeps the root span in slow_spans (500ms and 250.5ms, both >100ms).
    expect(parsed.slow_spans.map(span => span.span_id)).toEqual(['root-span', 'slow-span'])
    expect(parsed.frames_count).toBe(1)
  })

  it('reuses the cached session across queries and re-logs-in after TTL expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_TRACE_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_TRACE_RESPONSE))
      .mockResolvedValueOnce(loginResponse('S2'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_TRACE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeGrafanaService(new Context(), { sessionTtlMs: 60_000 })
    const params = { traceId: TRACE_ID, datasourceUid: 'uid' }

    await service.queryTrace(params)
    await service.queryTrace(params)
    // Second query reused the cached session: no second login.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].headers).toMatchObject({
      cookie: 'grafana_session=S1',
    })

    vi.setSystemTime(1_800_000_000_000 + 61_000)
    await service.queryTrace(params)
    // TTL expired → fresh login before the third query.
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect((fetchMock.mock.calls[3] as [string])[0]).toBe(`${GRAFANA}/login`)
    expect((fetchMock.mock.calls[4] as [string, RequestInit])[1].headers).toMatchObject({
      cookie: 'grafana_session=S2',
    })
  })

  it('refreshes the session and retries once on 401, like _main', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('STALE'))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(loginResponse('FRESH'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_TRACE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeGrafanaService(new Context())
    const parsed = await service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' })

    expect(parsed.frames_count).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe(`${GRAFANA}/login`)
    expect((fetchMock.mock.calls[3] as [string, RequestInit])[1].headers).toMatchObject({
      cookie: 'grafana_session=FRESH',
    })
  })

  it('does not retry non-auth HTTP errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('Grafana query HTTP 500: boom')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('wraps login HTTP errors with the original wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(loginResponse(undefined, 401, 'invalid credentials')))
    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('Grafana 登录失败 HTTP 401: invalid credentials')
  })

  it('wraps login connection failures with the original wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('Grafana 登录连接失败: ECONNREFUSED')
  })

  it('fails when the login response carries no grafana_session cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(loginResponse(undefined, 200, '{"message":"Logged in"}')))
    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('登录成功但未返回 grafana_session cookie，响应: {"message":"Logged in"}')
  })

  it('wraps query connection failures with the original wording', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('Grafana query 连接失败: ETIMEDOUT')
  })

  it('wraps non-JSON query responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('Grafana query 响应不是合法 JSON')
  })

  it('fails fast when credentials are missing', async () => {
    const ctx = new Context()
    const service = new TraceService(ctx, { endpoint: GRAFANA })
    await expect(service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid' }))
      .rejects.toThrow('traces 凭据缺失，需要 username/password 或凭据引用注入')
  })

  it('fails fast when datasource_uid is missing', async () => {
    const service = makeGrafanaService(new Context())
    await expect(service.queryTrace({ traceId: TRACE_ID }))
      .rejects.toThrow('traces.datasource_uid 缺失')
  })

  it('defaults the time range to [now-1h, now] and treats empty strings as unset', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_TRACE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeGrafanaService(new Context())
    await service.queryTrace({ traceId: TRACE_ID, datasourceUid: 'uid', start: '', end: '' })
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(body.from).toBe(String(1_800_000_000_000 - 3600_000))
    expect(body.to).toBe(String(1_800_000_000_000))
  })

  it('builds a dry-run preview with a masked cookie and the real query string', async () => {
    const service = makeGrafanaService(new Context())
    const preview = await service.buildQueryPreview({
      traceId: TRACE_ID,
      datasourceUid: 'GreptimeDB-Jaeger',
      datasourceId: 6,
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T10:30:00Z',
    })
    expect(preview['url']).toBe(`${GRAFANA}/api/ds/query?ds_type=jaeger&requestId=trace_${TRACE_ID}`)
    expect(preview['headers']).toEqual({ cookie: 'grafana_session=...' })
    const body = preview['body'] as { queries: Record<string, unknown>[]; from: string; to: string }
    expect(body.queries[0]).toMatchObject({
      refId: 'A',
      datasource: { type: 'jaeger', uid: 'GreptimeDB-Jaeger' },
      query: TRACE_ID,
      datasourceId: 6,
    })
    expect(body.from).toBe(String(Date.parse('2026-07-27T10:00:00Z')))
  })
})

describe('TraceService.queryTrace (jaeger native)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const NATIVE_RESPONSE = {
    data: [{
      traceID: TRACE_ID,
      processes: {
        p1: { serviceName: 'gateway' },
        p2: { serviceName: 'pay-svc' },
      },
      spans: [
        {
          spanID: 'root-span',
          operationName: 'GET /api/order',
          references: [],
          startTime: 1723000000000000,
          duration: 500000,
          tags: [],
          processID: 'p1',
        },
        {
          spanID: 'err-span',
          operationName: 'POST /api/pay',
          references: [{ refType: 'CHILD_OF', traceID: TRACE_ID, spanID: 'root-span' }],
          startTime: 1723000000100000,
          duration: 120000,
          tags: [{ key: 'otel.status_code', type: 'string', value: 'ERROR' }],
          processID: 'p2',
        },
      ],
    }],
  }

  it('GETs with a bearer token and maps the native response onto the contract', async () => {
    vi.stubEnv('JAEGER_TEST_TOKEN', 'tok-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(NATIVE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const service = new TraceService(new Context(), {
      mode: 'jaeger',
      endpoint: `${JAEGER}/`,
      tokenRef: 'JAEGER_TEST_TOKEN',
    })
    const parsed = await service.queryTrace({ traceId: TRACE_ID })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${JAEGER}/api/traces/${TRACE_ID}`)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-1')

    expect(parsed.frames_count).toBe(1)
    expect(parsed.duration_ms).toBe(500)
    expect(parsed.status).toBe('error')
    expect(parsed.services).toEqual(['gateway', 'pay-svc'])
    expect(parsed.spans[0]).toMatchObject({
      span_id: 'root-span',
      parent_id: null,
      service: 'gateway',
      duration_ms: 500,
      status: 'ok',
    })
    expect(parsed.spans[1]).toMatchObject({
      span_id: 'err-span',
      parent_id: 'root-span',
      service: 'pay-svc',
      duration_ms: 120,
      status: 'error',
    })
    expect(parsed.slow_spans.map(span => span.span_id)).toEqual(['root-span', 'err-span'])
  })

  it('fails fast when the token is missing', async () => {
    const service = new TraceService(new Context(), { mode: 'jaeger', endpoint: JAEGER })
    await expect(service.queryTrace({ traceId: TRACE_ID }))
      .rejects.toThrow('traces.token 缺失，需要 token 或凭据引用注入')
  })

  it('wraps native HTTP errors without a session retry', async () => {
    vi.stubEnv('JAEGER_TEST_TOKEN', 'tok-1')
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new TraceService(new Context(), {
      mode: 'jaeger',
      endpoint: JAEGER,
      tokenRef: 'JAEGER_TEST_TOKEN',
    })
    await expect(service.queryTrace({ traceId: TRACE_ID }))
      .rejects.toThrow('Jaeger query HTTP 403: forbidden')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('parseTraceResponse', () => {
  it('keeps raw_response when frames are missing or empty', () => {
    for (const response of [{}, { results: {} }, { results: { A: { frames: [] } } }, null, 'nope']) {
      const parsed = parseTraceResponse(response)
      expect(parsed.status).toBe('unknown')
      expect(parsed.spans).toEqual([])
      expect(parsed.frames_count).toBe(0)
      expect(parsed.raw_response).toEqual(response)
    }
  })

  it('keeps raw_response when schema fields or values are empty', () => {
    const response = { results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } } }
    const parsed = parseTraceResponse(response)
    expect(parsed.frames_count).toBe(1)
    expect(parsed.spans).toEqual([])
    expect(parsed.raw_response).toEqual(response)
  })

  it('flags error spans by otel.status_code, error tag, and stack traces', () => {
    const response = {
      results: {
        A: {
          frames: [{
            schema: {
              fields: [
                { name: 'spanID' },
                { name: 'parentSpanID' },
                { name: 'operationName' },
                { name: 'serviceName' },
                { name: 'duration' },
                { name: 'tags' },
                { name: 'stackTraces' },
              ],
            },
            data: {
              values: [
                ['a', 'b', 'c', 'd'],
                [null, 'a', 'a', 'a'],
                ['op1', 'op2', 'op3', 'op4'],
                ['svc', 'svc', 'svc', 'svc'],
                [10, 20, 30, 40],
                [
                  [{ key: 'otel.status_code', value: 'ERROR' }],
                  [{ key: 'error', value: true }],
                  [{ key: 'http.response.status_code', value: '404' }],
                  [],
                ],
                [null, null, null, ['traceback...']],
              ],
            },
          }],
        },
      },
    }
    const parsed = parseTraceResponse(response)
    expect(parsed.errors.map(span => span.span_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(parsed.status).toBe('error')
    expect(parsed.duration_ms).toBe(10)
  })

  it('treats 2xx/3xx http status tags and empty stack traces as ok', () => {
    const response = {
      results: {
        A: {
          frames: [{
            schema: {
              fields: [
                { name: 'spanID' },
                { name: 'parentSpanID' },
                { name: 'serviceName' },
                { name: 'duration' },
                { name: 'tags' },
                { name: 'stackTraces' },
              ],
            },
            data: {
              values: [
                ['a'],
                [null],
                ['svc'],
                [42],
                [[{ key: 'http.response.status_code', value: '302' }]],
                [[]],
              ],
            },
          }],
        },
      },
    }
    const parsed = parseTraceResponse(response)
    expect(parsed.status).toBe('ok')
    expect(parsed.errors).toEqual([])
    expect(parsed.spans[0]!.stack_traces).toBeNull()
    expect(parsed.slow_spans).toEqual([])
  })
})

describe('parseJaegerTraceResponse', () => {
  it('keeps raw_response when data is missing or empty', () => {
    for (const response of [{}, { data: [] }, null]) {
      const parsed = parseJaegerTraceResponse(response)
      expect(parsed.status).toBe('unknown')
      expect(parsed.raw_response).toEqual(response)
    }
  })
})
