import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LogStore, type ListLogServicesRequest, type LogQueryRequest, type LogQueryResult } from '@dsh-sentry/log-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as logAnalyzer from '../src/index.ts'

class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(): unknown[] {
    return []
  }

  async assemble(): Promise<{ sections: unknown[] }> {
    return { sections: [] }
  }
}

const RESULT: LogQueryResult = {
  timestampField: 'greptime_timestamp',
  records: [
    { greptime_timestamp: '2026-07-27T10:00:00Z', message: 'ERROR connection refused' },
    { greptime_timestamp: '2026-07-27T10:00:01Z', message: 'ERROR connection refused' },
  ],
}

class FakeLogStore extends LogStore {
  queries: LogQueryRequest[] = []
  lists: ListLogServicesRequest[] = []
  error?: Error

  override get backendRef(): string {
    return 'fake:greptimedb/public'
  }

  override get logFilterFields(): readonly string[] {
    return ['message', 'level', 'workload_name']
  }

  override async queryLogs(request: LogQueryRequest): Promise<LogQueryResult> {
    this.queries.push(request)
    if (this.error) throw this.error
    return RESULT
  }

  override async listLogServices(request: ListLogServicesRequest): Promise<string[]> {
    this.lists.push(request)
    if (this.error) throw this.error
    return ['checkout', 'media-bridge']
  }
}

interface Envelope {
  evidence: {
    data: Record<string, unknown>
    refs?: string[]
    confidence: number
  }
}

let ctx: Context
let store: FakeLogStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeLogStore)
  store = ctx.logStore as FakeLogStore
  await ctx.plugin(logAnalyzer, { env: 'test' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_query_logs' | 'sentry_list_log_services') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-log-analyzer LogStore Consumer', () => {
  it('passes backend-neutral intent to the Definition and uses its identity', async () => {
    const output = await tool('sentry_query_logs').execute({
      services: [' checkout ', ''],
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T10:30:00Z',
      keywords: ['ERROR'],
      filters: ['level=ERROR'],
      filterOr: ['tenant=a'],
      limit: 500,
      logType: 'go',
    }, {} as never) as Envelope

    expect(store.queries).toEqual([{
      services: ['checkout'],
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T10:30:00Z',
      keywords: ['ERROR'],
      filters: ['level=ERROR'],
      filterOr: ['tenant=a'],
      limit: 500,
      logType: 'go',
    }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:greptimedb/public',
      service: 'checkout',
      logs: RESULT.records,
    })
    expect(output.evidence.data).not.toHaveProperty('sql')
    expect(output.evidence.refs?.[0]).toBe('fake:greptimedb/public')
  })

  it('lists services through the same seam without SQL evidence', async () => {
    const output = await tool('sentry_list_log_services').execute({ logType: 'go' }, {} as never) as Envelope

    expect(store.lists).toEqual([{ logType: 'go' }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:greptimedb/public',
      services: ['checkout', 'media-bridge'],
    })
    expect(output.evidence.data).not.toHaveProperty('sql')
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    store.error = new Error('unknown field')
    const output = await tool('sentry_query_logs').execute({
      start: '2026-07-27T10:00:00Z',
      end: '2026-07-27T10:30:00Z',
    }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'unknown field' })
  })
})
