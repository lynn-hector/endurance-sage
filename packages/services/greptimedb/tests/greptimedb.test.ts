import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GreptimeDbService, parseGreptimeRows } from '../src/index.ts'
import { encryptConnectToken } from './helpers.ts'

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

  it('uses decrypted credentials from a connect token — token wins over username/password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GT_TOKEN', encryptConnectToken({ h: 'https://greptimedb.example.com', u: 'tok-user', p: 'tok-pass' }))
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')

    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      usernameRef: 'GT_USER',
      passwordRef: 'GT_PASS',
      connectTokenRef: 'GT_TOKEN',
    })

    const rows = await service.query('SELECT 1')
    expect(rows).toHaveLength(2)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Basic ${Buffer.from('tok-user:tok-pass', 'utf8').toString('base64')}`)
  })

  it('fails fast on an undecryptable connect token even when username/password exist', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('GT_TOKEN', 'not-a-valid-token-12345678901234567890')
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')

    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      usernameRef: 'GT_USER',
      passwordRef: 'GT_PASS',
      connectTokenRef: 'GT_TOKEN',
    })
    await expect(service.query('SELECT 1')).rejects.toThrow('connect token')
  })

  it('rejects a token whose payload lacks username/password', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('GT_TOKEN', encryptConnectToken({ h: 'https://greptimedb.example.com', d: 'public' }))

    const ctx = new Context()
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      connectTokenRef: 'GT_TOKEN',
    })
    await expect(service.query('SELECT 1')).rejects.toThrow('缺 username/password')
  })

  it('warns but proceeds when the token host mismatches the configured endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GT_TOKEN', encryptConnectToken({ h: 'https://greptimedb.other-env.example.com', u: 'u', p: 'p' }))

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const service = new GreptimeDbService(ctx, {
      endpoint: 'https://greptimedb.example.com',
      connectTokenRef: 'GT_TOKEN',
    })

    const rows = await service.query('SELECT 1')
    expect(rows).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
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

describe('parseGreptimeRows — timestamp column normalization', () => {
  const bodyWith = (datatypeKey: string, rowValue: unknown) => ({
    output: [{
      records: {
        schema: { column_schemas: [{ name: 'greptime_timestamp', [datatypeKey]: 'timestamp' }, { name: 'message' }] },
        rows: [[rowValue, 'hi']],
      },
    }],
  })

  it('normalizes nanosecond numbers to ISO8601 with 9 fractional digits', () => {
    const rows = parseGreptimeRows(bodyWith('datatype', 1760078093123456789))
    // The numeric literal exceeds Number.MAX_SAFE_INTEGER, so the double
    // rounds to ...456768 — sub-millisecond digits cannot survive the number path.
    expect(rows[0]!['greptime_timestamp']).toBe('2025-10-10T06:34:53.123456768Z')
  })

  it('normalizes nanosecond digit-strings the same way', () => {
    const rows = parseGreptimeRows(bodyWith('data_type', '1760078093123456789'))
    // Digit-strings are parsed as exact BigInts, so all 9 fractional digits survive.
    expect(rows[0]!['greptime_timestamp']).toBe('2025-10-10T06:34:53.123456789Z')
  })

  it('normalizes millisecond numbers with 3 fractional digits', () => {
    const rows = parseGreptimeRows(bodyWith('datatype', 1760078093123))
    expect(rows[0]!['greptime_timestamp']).toBe('2025-10-10T06:34:53.123Z')
  })

  it('keeps date-shaped strings untouched', () => {
    const rows = parseGreptimeRows(bodyWith('datatype', '2026-10-10T07:14:53.123456789Z'))
    expect(rows[0]!['greptime_timestamp']).toBe('2026-10-10T07:14:53.123456789Z')
  })

  it('keeps null untouched', () => {
    const rows = parseGreptimeRows(bodyWith('datatype', null))
    expect(rows[0]!['greptime_timestamp']).toBeNull()
  })

  it('leaves values alone when the schema carries no datatype', () => {
    const rows = parseGreptimeRows({
      output: [{
        records: {
          schema: { column_schemas: [{ name: 'greptime_timestamp' }, { name: 'message' }] },
          rows: [[1760078093123456789, 'hi']],
        },
      }],
    })
    expect(rows[0]!['greptime_timestamp']).toBe(1760078093123456789)
  })

  it('integral values beyond the Date range pass through untouched instead of throwing（怪值不该炸掉整条查询）', () => {
    const huge = parseGreptimeRows(bodyWith('datatype', '99999999999999999999999')) // 23 位 → ns 路径 → 秒值远超 Date 上限
    expect(huge[0]!['greptime_timestamp']).toBe('99999999999999999999999')
    expect(() => parseGreptimeRows(bodyWith('datatype', '99999999999999999999999'))).not.toThrow()
  })
})
