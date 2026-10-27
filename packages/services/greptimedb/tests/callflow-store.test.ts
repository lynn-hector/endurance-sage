import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GreptimeCallflowStore, GreptimeTransport } from '../src/index.ts'

const SAMPLE_RESPONSE = {
  output: [{
    records: {
      schema: {
        column_schemas: [
          { name: 'greptime_timestamp', datatype: 'timestamp' },
          { name: 'sip_method' },
          { name: 'call_id' },
          { name: 'trace_id' },
        ],
      },
      rows: [
        ['2026-06-01T10:00:00.000Z', 'INVITE', 'call-1', 't-1'],
        ['2026-06-01T10:00:02.000Z', '200', 'call-1', 't-1'],
      ],
    },
  }],
}

describe('GreptimeCallflowStore.queryCallFlow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('builds dual-key signaling SQL in the Provider and returns the neutral summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE_RESPONSE), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GT_USER', 'alice')
    vi.stubEnv('GT_PASS', 's3cret')

    const ctx = new Context()
    const store = new GreptimeCallflowStore(ctx, {
      transport: new GreptimeTransport(ctx, {
        endpoint: 'https://greptimedb.example.com',
        usernameRef: 'GT_USER',
        passwordRef: 'GT_PASS',
      }),
      schema: 'public',
      table: 'hep_1',
      timestampCol: 'greptime_timestamp',
    })

    const result = await store.queryCallFlow({
      callId: 'call-1',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-01T23:59:59Z',
      limit: 1000,
    })

    expect(result.messages).toHaveLength(2)
    expect(result.summary).toMatchObject({
      total: 2,
      milestones: {
        invite_at: '2026-06-01T10:00:00.000Z',
        answer_at: '2026-06-01T10:00:02.000Z',
      },
      pdd_ms: 2000,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://greptimedb.example.com/v1/sql?db=public')
    expect(init.body).toBe(`sql=${encodeURIComponent(
      `SELECT * FROM "public"."hep_1" `
      + `WHERE ("call_id" = 'call-1' OR "trace_id" = 'call-1') `
      + `AND "greptime_timestamp" >= '2026-06-01T00:00:00Z' `
      + `AND "greptime_timestamp" <= '2026-06-01T23:59:59Z' `
      + `ORDER BY "greptime_timestamp" ASC LIMIT 1000`,
    )}`)

    await ctx.fiber.dispose()
  })
})
