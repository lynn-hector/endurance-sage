import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DbxService, {
  DBX_BASE_HEADERS,
  extractCookie,
  pickDbxConnection,
} from '../src/index.ts'

/**
 * Golden tests: request shapes asserted here are pinned to
 * `skills/lib/dbx.py` field by field (login headers, execute-multi body,
 * verbatim query-string join, browser headers), and the session/fallback
 * choreography is pinned to `ensure_session` + the two scripts'
 * `_*_with_fallback` loops.
 */

const ENDPOINT = 'https://dbx.example.com'

/** Login response carrying (or omitting) the dbx_session Set-Cookie. */
function loginResponse(session: string | undefined, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => session !== undefined
        ? [`dbx_session=${session}; Path=/; HttpOnly`]
        : [],
      get: () => null,
    },
    text: async () => '{"ok":true}',
    json: async () => ({}),
  } as unknown as Response
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function lastCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mock.mock.calls.at(-1)
  if (call === undefined) throw new Error('expected at least one fetch call')
  return call as [string, RequestInit]
}

function makeService(ctx: Context, extra: Record<string, unknown> = {}): DbxService {
  return new DbxService(ctx, {
    endpoint: ENDPOINT,
    password: 'dbx-secret',
    ...extra,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('extractCookie', () => {
  it('reads the named cookie out of Set-Cookie headers, like _extract_cookie', () => {
    expect(extractCookie(loginResponse('SESSION42'), 'dbx_session')).toBe('SESSION42')
  })

  it('returns undefined when the cookie is absent', () => {
    expect(extractCookie(loginResponse(undefined), 'dbx_session')).toBeUndefined()
  })
})

describe('pickDbxConnection — port of _pick_connection', () => {
  const connections = [
    { id: 'conn-pg-1', db_type: 'postgres', name: 'prod pg' },
    { id: 'conn-redis-1', db_type: 'redis', name: 'prod redis' },
    { id: 'conn-other', db_type: 'mysql', name: 'has redis in name' },
  ]

  it('prefers an exact preferred id over hints', () => {
    expect(pickDbxConnection(connections, 'redis', 'conn-pg-1')?.['id']).toBe('conn-pg-1')
  })

  it('matches db_type before name substrings', () => {
    expect(pickDbxConnection(connections, 'redis')?.['id']).toBe('conn-redis-1')
  })

  it('falls back to a lowercase name substring', () => {
    const named = [{ id: 'x1', db_type: 'mysql', name: 'Main Redis Cluster' }]
    expect(pickDbxConnection(named, 'redis')?.['id']).toBe('x1')
  })

  it('returns undefined when nothing matches', () => {
    expect(pickDbxConnection([{ id: 'a', db_type: 'mysql' }], 'redis')).toBeUndefined()
  })
})

describe('DbxService login — golden request construction', () => {
  it('POSTs the password JSON with the script-era headers and extracts the session cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginResponse('S1'))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const session = await service.ensureSession()

    expect(session).toBe('S1')
    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(`${ENDPOINT}/api/auth/login`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ password: 'dbx-secret' })
    const headers = init.headers as Record<string, string>
    // dbx.py._login: content-type + referer:/login win, base headers fill in, origin forced.
    expect(headers['content-type']).toBe('application/json')
    expect(headers['referer']).toBe(`${ENDPOINT}/login`)
    expect(headers['origin']).toBe(ENDPOINT)
    expect(headers['user-agent']).toBe(DBX_BASE_HEADERS['user-agent'])
  })

  it('keeps the original error wordings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })))
    const service = makeService(new Context())
    await expect(service.ensureSession()).rejects.toThrow('dbx 登录失败 HTTP 403: nope')
  })

  it('throws when the login succeeds without a session cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(loginResponse(undefined)))
    const service = makeService(new Context())
    await expect(service.ensureSession()).rejects.toThrow('登录成功但未返回 dbx_session cookie')
  })
})

describe('DbxService session cache', () => {
  it('reuses a cached session when /api/auth/check passes, without re-login', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1')) // login
      .mockResolvedValueOnce(jsonResponse({ authenticated: true })) // check
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    await service.ensureSession()
    const again = await service.ensureSession()

    expect(again).toBe('S1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastCall(fetchMock)[0]).toBe(`${ENDPOINT}/api/auth/check`)
  })

  it('re-logs-in when the cached session is server-rejected (401)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(loginResponse('S2'))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    await service.ensureSession()
    const refreshed = await service.ensureSession()

    expect(refreshed).toBe('S2')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('shares one in-flight login across concurrent ensureSession calls (single-flight)', async () => {
    let resolveLogin: ((resp: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveLogin = resolve
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const first = service.ensureSession()
    const second = service.ensureSession()
    // Let the login microtask chain reach the fetch call before resolving it.
    await new Promise(resolve => setTimeout(resolve, 0))
    resolveLogin?.(loginResponse('S1'))

    expect(await first).toBe('S1')
    expect(await second).toBe('S1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('DbxService.request — port of dbx_request', () => {
  it('forces origin/referer over caller headers and joins params verbatim', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const session = await service.ensureSession()
    await service.request('/api/schema/databases', {
      params: { connection_id: 'auto-init-pg' },
      headers: { referer: 'https://evil.example/' },
      session,
    })

    const [url, init] = lastCall(fetchMock)
    // The original joins k=v with "&" and no URL encoding.
    expect(url).toBe(`${ENDPOINT}/api/schema/databases?connection_id=auto-init-pg`)
    const headers = init.headers as Record<string, string>
    expect(headers['referer']).toBe(`${ENDPOINT}/`)
    expect(headers['origin']).toBe(ENDPOINT)
    expect(headers['cookie']).toBe('dbx_session=S1')
    expect(headers['sec-fetch-site']).toBe('same-origin')
  })

  it('wraps failures with the original wordings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const service = makeService(new Context())
    await expect(service.request('/api/auth/check', { session: 'x' }))
      .rejects.toThrow('dbx 连接失败: ECONNRESET')
  })
})

describe('DbxService.executeQuery — golden execute-multi body', () => {
  it('sends the script-era body fields and applies the empty-results fallback quirk', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const results = await service.executeQuery('auto-init-pg', 'novo_cfg', 'SELECT 1', { maxRows: 50 })

    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(`${ENDPOINT}/api/query/execute-multi`)
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['connectionId']).toBe('auto-init-pg')
    expect(body['database']).toBe('novo_cfg')
    expect(body['sql']).toBe('SELECT 1')
    expect(body['maxRows']).toBe(50)
    expect(body['fetchSize']).toBe(50)
    expect(body['timeoutSecs']).toBe(30)
    expect(typeof body['executionId']).toBe('string')
    expect(typeof body['clientSessionId']).toBe('string')

    // Python `resp.get("results", []) or [resp]`: empty list falls back to [resp].
    expect(results).toEqual([{ results: [] }])
  })
})

describe('DbxService.discoverConnection', () => {
  it('lists, picks by type, connects, and caches the result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-redis-1', db_type: 'redis', name: 'main redis' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'conn-redis-1' }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const discovered = await service.discoverConnection('redis')

    expect(discovered.id).toBe('conn-redis-1')
    const [connectUrl, connectInit] = lastCall(fetchMock)
    expect(connectUrl).toBe(`${ENDPOINT}/api/connection/connect`)
    expect(JSON.parse(connectInit.body as string))
      .toEqual({ config: { id: 'conn-redis-1', db_type: 'redis', name: 'main redis' } })

    // Second call is served from the in-memory cache: no further fetches.
    const again = await service.discoverConnection('redis')
    expect(again.id).toBe('conn-redis-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports available connections when the type is missing, original wording', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-mysql', db_type: 'mysql' }]))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    await expect(service.discoverConnection('redis'))
      .rejects.toThrow('dbx 未找到类型 redis 的连接，可用连接: ["conn-mysql"]')
  })
})

describe('DbxService.redisGetValue', () => {
  it('base64-encodes the key into keyRaw, like _query_value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({ key_display: 'session:user:1' }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    await service.redisGetValue('conn-redis-1', 3, 'session:user:1')

    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(`${ENDPOINT}/api/redis/get-value`)
    expect(JSON.parse(init.body as string)).toEqual({
      connectionId: 'conn-redis-1',
      db: 3,
      keyRaw: 'c2Vzc2lvbjp1c2VyOjE=',
    })
  })
})

describe('DbxService.runWithFallback — port of the scripts\' *_with_fallback loops', () => {
  it('returns the first success without any fallback', async () => {
    const service = makeService(new Context())
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await service.runWithFallback('postgres', 'conn-1', undefined, fn)
    expect(result).toEqual({ value: 'ok', connectionId: 'conn-1' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('on 401 clears auth state, re-logs-in, and retries the SAME connection id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginResponse('S2'))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('dbx HTTP 401: expired'))
      .mockResolvedValueOnce('retried')

    const result = await service.runWithFallback('postgres', 'conn-1', undefined, fn)
    expect(result).toEqual({ value: 'retried', connectionId: 'conn-1' })
    expect(fn).toHaveBeenCalledTimes(2)
    // Re-login went through the login endpoint (session cache was cleared).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastCall(fetchMock)[0]).toBe(`${ENDPOINT}/api/auth/login`)
  })

  it('on non-auth errors discovers a fresh connection and runs once more', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-new', db_type: 'postgres' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'conn-new' }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('dbx HTTP 500: boom'))
      .mockResolvedValueOnce('discovered-ok')

    const result = await service.runWithFallback('postgres', 'conn-dead', undefined, fn)
    expect(result).toEqual({ value: 'discovered-ok', connectionId: 'conn-new' })
    expect(fn.mock.calls.map(call => call[0])).toEqual(['conn-dead', 'conn-new'])
  })

  it('gives up the retry loop after a second auth failure and also discovers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S2')) // re-login after clearSession
      .mockResolvedValueOnce(jsonResponse({ authenticated: true })) // checkAuth in discovery's ensureSession
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-new', db_type: 'postgres' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'conn-new' }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('dbx HTTP 401: expired'))
      .mockRejectedValueOnce(new Error('dbx HTTP 403: still no'))
      .mockResolvedValueOnce('finally')

    const result = await service.runWithFallback('postgres', 'conn-1', undefined, fn)
    expect(result.connectionId).toBe('conn-new')
    expect(result.value).toBe('finally')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
