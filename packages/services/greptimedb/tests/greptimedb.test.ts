import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GreptimeDbService, parseGreptimeRows } from '../src/index.ts'

const SAMPLE_RESPONSE = {
  output: [
    {
      records: {
        schema: { column_schemas: [{ name: 'workload_name' }, { name: 'message' }] },
        rows: [
          ['commctl-config', 'ERROR boom'],
          ['media-bridge', 'INFO ok'],
        ],
      },
    },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('GreptimeDbService.query', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('POSTs form-encoded SQL with Basic auth and parses rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')

    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com/',
      database: 'logs',
      usernameRef: 'GT_USER',
      passwordRef: 'GT_PASS',
      timeoutMs: 5000,
    })

    const rows = await service.query('SELECT 1')

    expect(rows).toEqual([
      { workload_name: 'commctl-config', message: 'ERROR boom' },
      { workload_name: 'media-bridge', message: 'INFO ok' },
    ])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://greptimedb.example.com/v1/sql?db=logs')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`)
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.body).toBe(`sql=${encodeURIComponent('SELECT 1')}`)
  })

  it('fails fast when endpoint or credentials are missing', async () => {
    const ctx = new Context()
    const service = new GreptimeDbService(ctx, { endpoint: '' })
    await expect(service.query('SELECT 1')).rejects.toThrow('endpoint 或凭据缺失')
  })

  it('wraps HTTP errors with status and detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad sql', { status: 400 })))
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')
    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      usernameRef: 'GT_USER',
      passwordRef: 'GT_PASS',
    })
    await expect(service.query('SELECT oops')).rejects.toThrow('GreptimeDB HTTP 400: bad sql')
  })

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')
    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      usernameRef: 'GT_USER',
      passwordRef: 'GT_PASS',
    })
    await expect(service.query('SELECT 1')).rejects.toThrow('GreptimeDB 连接失败: ECONNREFUSED')
  })

  it('wraps non-JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')
    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      usernameRef: 'GT_USER',
      passwordRef: 'GT_PASS',
    })
    await expect(service.query('SELECT 1')).rejects.toThrow('GreptimeDB 响应不是合法 JSON')
  })
})

describe('parseGreptimeRows', () => {
  it('returns [] for empty or malformed responses', () => {
    expect(parseGreptimeRows({})).toEqual([])
    expect(parseGreptimeRows({ output: [] })).toEqual([])
    expect(parseGreptimeRows(null)).toEqual([])
    expect(parseGreptimeRows('nope')).toEqual([])
  })

  it('zips rows with column names and pads missing values with null', () => {
    const rows = parseGreptimeRows({
      output: [{
        records: {
          schema: { column_schemas: [{ name: 'a' }, { name: 'b' }] },
          rows: [[1], 'not-a-row', [2, 3]],
        },
      }],
    })
    expect(rows).toEqual([{ a: 1, b: null }, { a: 2, b: 3 }])
  })
})
