import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DbxService, {
  DBX_BASE_HEADERS,
  DbxCacheStore,
  DbxDbStore,
  DbxPlatformClient,
  extractCookie,
  pickDbxConnection,
} from '../src/index.ts'

/**
 * Golden tests: request shapes asserted here are pinned to
 * `skills/lib/dbx.py` field by field (login headers, execute-multi body,
 * verbatim query-string join, browser headers), and the session/fallback
 * choreography is pinned to `ensure_session` + the two scripts'
 * `_*_with_fallback` loops. The two Provider slots are exercised through
 * their backend-neutral seams (`querySql` / `getValue`) over fetch mocks.
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

/** Contexts created by tests, disposed together in afterEach. */
const contexts: Context[] = []

function makeClient(extra: Record<string, unknown> = {}): DbxPlatformClient {
  const ctx = new Context()
  contexts.push(ctx)
  return new DbxPlatformClient(ctx, {
    endpoint: ENDPOINT,
    password: 'dbx-secret',
    ...extra,
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  while (contexts.length > 0) {
    const ctx = contexts.pop()
    await ctx!.fiber.dispose()
  }
})

describe('extractCookie', () => {
  it('reads the named cookie out of Set-Cookie headers, like _extract_cookie', () => {
    expect(extractCookie(loginResponse('SESSION42').headers, 'dbx_session')).toBe('SESSION42')
  })

  it('returns undefined when the cookie is absent', () => {
    expect(extractCookie(loginResponse(undefined).headers, 'dbx_session')).toBeUndefined()
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

describe('DbxService provider slots', () => {
  it('mounts dbStore and cacheStore over one shared platform client', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(DbxService, { endpoint: ENDPOINT, password: 'dbx-secret' })

    expect(ctx.dbStore.backendRef).toBe(`dbx:${ENDPOINT}`)
    expect(ctx.dbStore.backendRef).toBe(ctx.cacheStore.backendRef)
  })
})

describe('DbxDbStore.querySql — provider choreography behind the seam', () => {
  it('discovers, warms the database list, executes, and returns neutral results', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1')) // login (discovery)
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-pg-1', db_type: 'postgres', name: 'prod pg' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'conn-pg-1' })) // connect
      .mockResolvedValueOnce(jsonResponse({ authenticated: true })) // auth/check (listDatabases)
      .mockResolvedValueOnce(jsonResponse(['novo_cfg', 'novo_commctl_config'])) // schema/databases
      .mockResolvedValueOnce(jsonResponse({ authenticated: true })) // auth/check (executeQuery)
      .mockResolvedValueOnce(jsonResponse({ results: [{ columns: ['probe'], rows: [[1]] }] }))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient({ postgresConnectionId: 'conn-pg-1' })
    const ctx = contexts.at(-1)!
    const store = new DbxDbStore(ctx, { client, preferredConnectionId: 'conn-pg-1' })

    const result = await store.querySql({ sql: 'SELECT 1', database: 'novo_cfg', maxRows: 50 })

    expect(result).toEqual({
      database: 'novo_cfg',
      connectionId: 'conn-pg-1',
      results: [{ columns: ['probe'], rows: [[1]] }],
    })
    // Discovery warm-up (login + list + connect), database-list warm-up with
    // its auth re-check, another auth re-check, then execute-multi.
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `${ENDPOINT}/api/auth/login`,
      `${ENDPOINT}/api/connection/list`,
      `${ENDPOINT}/api/connection/connect`,
      `${ENDPOINT}/api/auth/check`,
      `${ENDPOINT}/api/schema/databases?connection_id=conn-pg-1`,
      `${ENDPOINT}/api/auth/check`,
      `${ENDPOINT}/api/query/execute-multi`,
    ])
    const body = JSON.parse(lastCall(fetchMock)[1].body as string) as Record<string, unknown>
    expect(body['database']).toBe('novo_cfg')
    expect(body['maxRows']).toBe(50)
  })
})

describe('DbxCacheStore.getValue — provider decoding behind the seam', () => {
  it('runs the redis wire call and returns the decoded neutral entry', async () => {
    const valueB64 = Buffer.from('{"tenant":"a"}', 'utf8').toString('base64')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({
        key_display: 'session:user:1',
        key_raw: 'a2V5',
        ttl: 300,
        redis_type: 'string',
        data: { content: { encoding: 'utf8', raw_base64: valueB64 } },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient({ redisConnectionId: 'conn-redis-1' })
    const ctx = contexts.at(-1)!
    const store = new DbxCacheStore(ctx, { client, preferredConnectionId: 'conn-redis-1' })

    const entry = await store.getValue({ key: 'session:user:1', db: 3 })

    expect(entry).toMatchObject({
      key: 'session:user:1',
      db: 3,
      connectionId: 'conn-redis-1',
      keyDisplay: 'session:user:1',
      ttl: 300,
      redisType: 'string',
      value: { tenant: 'a' },
      valueEncoding: 'utf8',
      valueRawBase64: valueB64,
    })
    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(`${ENDPOINT}/api/redis/get-value`)
    expect(JSON.parse(init.body as string)).toEqual({
      connectionId: 'conn-redis-1',
      db: 3,
      keyRaw: 'c2Vzc2lvbjp1c2VyOjE=',
    })
  })
})

describe('DbxPlatformClient login — golden request construction', () => {
  it('POSTs the password JSON with the script-era headers and extracts the session cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginResponse('S1'))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    const session = await client.ensureSession()

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
    const client = makeClient()
    await expect(client.ensureSession()).rejects.toThrow('dbx 登录失败 HTTP 403: nope')
  })

  it('throws when the login succeeds without a session cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(loginResponse(undefined)))
    const client = makeClient()
    await expect(client.ensureSession()).rejects.toThrow('登录成功但未返回 dbx_session cookie')
  })
})

describe('DbxPlatformClient session cache', () => {
  it('reuses a cached session when /api/auth/check passes, without re-login', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1')) // login
      .mockResolvedValueOnce(jsonResponse({ authenticated: true })) // check
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    await client.ensureSession()
    const again = await client.ensureSession()

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

    const client = makeClient()
    await client.ensureSession()
    const refreshed = await client.ensureSession()

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

    const client = makeClient()
    const first = client.ensureSession()
    const second = client.ensureSession()
    // Let the login microtask chain reach the fetch call before resolving it.
    await new Promise(resolve => setTimeout(resolve, 0))
    resolveLogin?.(loginResponse('S1'))

    expect(await first).toBe('S1')
    expect(await second).toBe('S1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('DbxPlatformClient.request — port of dbx_request', () => {
  it('forces origin/referer over caller headers and joins params verbatim', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    const session = await client.ensureSession()
    await client.request('/api/schema/databases', {
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
    const client = makeClient()
    await expect(client.request('/api/auth/check', { session: 'x' }))
      .rejects.toThrow('dbx 连接失败: ECONNRESET')
  })
})

describe('DbxPlatformClient.executeQuery — golden execute-multi body', () => {
  it('sends the script-era body fields and applies the empty-results fallback quirk', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    const results = await client.executeQuery('auto-init-pg', 'novo_cfg', 'SELECT 1', { maxRows: 50 })

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

describe('DbxPlatformClient.discoverConnection', () => {
  it('lists, picks by type, connects, and caches the result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-redis-1', db_type: 'redis', name: 'main redis' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'conn-redis-1' }))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    const discovered = await client.discoverConnection('redis')

    expect(discovered.id).toBe('conn-redis-1')
    const [connectUrl, connectInit] = lastCall(fetchMock)
    expect(connectUrl).toBe(`${ENDPOINT}/api/connection/connect`)
    expect(JSON.parse(connectInit.body as string))
      .toEqual({ config: { id: 'conn-redis-1', db_type: 'redis', name: 'main redis' } })

    // Second call is served from the in-memory cache: no further fetches.
    const again = await client.discoverConnection('redis')
    expect(again.id).toBe('conn-redis-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports available connections when the type is missing, original wording', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse([{ id: 'conn-mysql', db_type: 'mysql' }]))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    await expect(client.discoverConnection('redis'))
      .rejects.toThrow('dbx 未找到类型 redis 的连接，可用连接: ["conn-mysql"]')
  })
})

describe('DbxPlatformClient.redisGetValue', () => {
  it('base64-encodes the key into keyRaw, like _query_value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginResponse('S1'))
      .mockResolvedValueOnce(jsonResponse({ key_display: 'session:user:1' }))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    await client.redisGetValue('conn-redis-1', 3, 'session:user:1')

    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(`${ENDPOINT}/api/redis/get-value`)
    expect(JSON.parse(init.body as string)).toEqual({
      connectionId: 'conn-redis-1',
      db: 3,
      keyRaw: 'c2Vzc2lvbjp1c2VyOjE=',
    })
  })
})

describe('DbxPlatformClient.runWithFallback — port of the scripts\' *_with_fallback loops', () => {
  it('returns the first success without any fallback', async () => {
    const client = makeClient()
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await client.runWithFallback('postgres', 'conn-1', undefined, fn)
    expect(result).toEqual({ value: 'ok', connectionId: 'conn-1' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('on 401 clears auth state, re-logs-in, and retries the SAME connection id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginResponse('S2'))
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('dbx HTTP 401: expired'))
      .mockResolvedValueOnce('retried')

    const result = await client.runWithFallback('postgres', 'conn-1', undefined, fn)
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

    const client = makeClient()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('dbx HTTP 500: boom'))
      .mockResolvedValueOnce('discovered-ok')

    const result = await client.runWithFallback('postgres', 'conn-dead', undefined, fn)
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

    const client = makeClient()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('dbx HTTP 401: expired'))
      .mockRejectedValueOnce(new Error('dbx HTTP 403: still no'))
      .mockResolvedValueOnce('finally')

    const result = await client.runWithFallback('postgres', 'conn-1', undefined, fn)
    expect(result.connectionId).toBe('conn-new')
    expect(result.value).toBe('finally')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
