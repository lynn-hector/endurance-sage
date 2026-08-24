import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatPyFloat, PrometheusService } from '../src/index.ts'

const MATRIX_RESPONSE = {
  status: 'success',
  data: { resultType: 'matrix', result: [] },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
}

describe('PrometheusService.queryRange — golden request construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('GETs /api/v1/query_range with urlencoded params, Python-style float timestamps, and Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MATRIX_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('PROM_TOKEN', 'tok-abc')

    const ctx = new Context()
    const service = new PrometheusService(ctx, {
      endpoint: 'http://localhost:9090/',
      tokenRef: 'PROM_TOKEN',
      timeoutMs: 5000,
    })

    await service.queryRange(
      'rate(http_requests_total{service="order-service"}[1m])',
      1784714400, // 2026-07-22T10:00:00Z
      1784716200, // 2026-07-22T10:30:00Z
      '15s',
    )

    const [url, init] = lastCall(fetchMock)
    // Identical to the original script's
    // `endpoint + "/api/v1/query_range?" + urllib.parse.urlencode(params)`,
    // where the float timestamps stringify with a trailing `.0`.
    expect(url).toBe(
      'http://localhost:9090/api/v1/query_range'
      + '?query=rate%28http_requests_total%7Bservice%3D%22order-service%22%7D%5B1m%5D%29'
      + '&start=1784714400.0&end=1784716200.0&step=15s',
    )
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['accept']).toBe('application/json')
    expect(headers['authorization']).toBe('Bearer tok-abc')
  })

  it('uses Basic auth when only username/password credentials exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MATRIX_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('PROM_USER', 'alice')
    vi.stubEnv('PROM_PASS', 's3cret')

    const ctx = new Context()
    const service = new PrometheusService(ctx, {
      endpoint: 'http://localhost:9090',
      usernameRef: 'PROM_USER',
      passwordRef: 'PROM_PASS',
    })

    await service.queryRange('up', 1784714400, 1784716200, '15s')

    const headers = lastCall(fetchMock)[1].headers as Record<string, string>
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`,
    )
  })

  it('prefers the Bearer token over Basic credentials, like the original', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MATRIX_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('PROM_TOKEN', 'tok-abc')
    vi.stubEnv('PROM_USER', 'alice')
    vi.stubEnv('PROM_PASS', 's3cret')

    const ctx = new Context()
    const service = new PrometheusService(ctx, {
      endpoint: 'http://localhost:9090',
      tokenRef: 'PROM_TOKEN',
      usernameRef: 'PROM_USER',
      passwordRef: 'PROM_PASS',
    })

    await service.queryRange('up', 1784714400, 1784716200, '15s')

    const headers = lastCall(fetchMock)[1].headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer tok-abc')
  })

  it('connects anonymously when no credentials are configured (original local env)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MATRIX_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const service = new PrometheusService(ctx, { endpoint: 'http://localhost:9090' })

    await service.queryRange('up', 1784714400, 1784716200, '15s')

    const headers = lastCall(fetchMock)[1].headers as Record<string, string>
    expect(headers['accept']).toBe('application/json')
    expect(headers['authorization']).toBeUndefined()
  })

  it('resolves credentials per call, so a changed env var takes effect immediately', async () => {
    // Fresh Response per call: a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(MATRIX_RESPONSE)))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('PROM_TOKEN', 'tok-old')

    const ctx = new Context()
    const service = new PrometheusService(ctx, {
      endpoint: 'http://localhost:9090',
      tokenRef: 'PROM_TOKEN',
    })

    await service.queryRange('up', 1784714400, 1784716200, '15s')
    vi.stubEnv('PROM_TOKEN', 'tok-new')
    await service.queryRange('up', 1784714400, 1784716200, '15s')

    expect((lastCall(fetchMock)[1].headers as Record<string, string>)['authorization']).toBe('Bearer tok-new')
  })

  it('falls back to literal credentials when the reference is unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MATRIX_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const service = new PrometheusService(ctx, {
      endpoint: 'http://localhost:9090',
      tokenRef: 'PROM_TOKEN_UNSET',
      token: 'tok-literal',
    })

    await service.queryRange('up', 1784714400, 1784716200, '15s')

    const headers = lastCall(fetchMock)[1].headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer tok-literal')
  })
})

describe('PrometheusService.rules', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('GETs /api/v1/rules with Accept header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'success', data: { groups: [] } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const service = new PrometheusService(ctx, { endpoint: 'http://localhost:9090/' })

    const raw = await service.rules()

    expect(raw).toEqual({ status: 'success', data: { groups: [] } })
    const [url, init] = lastCall(fetchMock)
    expect(url).toBe('http://localhost:9090/api/v1/rules')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['accept']).toBe('application/json')
  })
})

describe('PrometheusService error paths — original Chinese wording', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('fails fast when the endpoint is not configured', async () => {
    const ctx = new Context()
    const service = new PrometheusService(ctx, { endpoint: '' })
    await expect(service.queryRange('up', 0, 1, '15s')).rejects.toThrow('endpoint 未配置')
    await expect(service.rules()).rejects.toThrow('endpoint 未配置')
  })

  it('wraps HTTP errors with status and body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 }))))
    const ctx = new Context()
    const service = new PrometheusService(ctx, { endpoint: 'http://localhost:9090' })
    await expect(service.queryRange('up', 0, 1, '15s')).rejects.toThrow('Prometheus HTTP 500: boom')
    await expect(service.rules()).rejects.toThrow('Prometheus HTTP 500: boom')
  })

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const ctx = new Context()
    const service = new PrometheusService(ctx, { endpoint: 'http://localhost:9090' })
    await expect(service.queryRange('up', 0, 1, '15s')).rejects.toThrow('请求 Prometheus 失败: ECONNREFUSED')
  })

  it('wraps non-JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    const ctx = new Context()
    const service = new PrometheusService(ctx, { endpoint: 'http://localhost:9090' })
    await expect(service.rules()).rejects.toThrow('请求 Prometheus 失败:')
  })
})

describe('formatPyFloat', () => {
  it('keeps a trailing .0 on integral values, like Python str(float)', () => {
    expect(formatPyFloat(1784714400)).toBe('1784714400.0')
    expect(formatPyFloat(0)).toBe('0.0')
  })

  it('renders fractional values plainly', () => {
    expect(formatPyFloat(1784714400.5)).toBe('1784714400.5')
  })
})
