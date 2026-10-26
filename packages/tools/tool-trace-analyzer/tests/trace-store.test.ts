import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TraceStore, type ParsedTrace, type TraceQueryRequest } from '@dsh-sentry/trace-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as traceAnalyzer from '../src/index.ts'

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

const RESULT: ParsedTrace = {
  duration_ms: 125,
  status: 'ok',
  services: ['checkout'],
  spans: [],
  slow_spans: [],
  errors: [],
  frames_count: 1,
}

class FakeTraceStore extends TraceStore {
  requests: TraceQueryRequest[] = []
  error?: Error

  override get backendRef(): string {
    return 'fake:trace-backend'
  }

  override async queryTrace(request: TraceQueryRequest): Promise<ParsedTrace> {
    this.requests.push(request)
    if (this.error) throw this.error
    return RESULT
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
let store: FakeTraceStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeTraceStore)
  store = ctx.traceStore as FakeTraceStore
  await ctx.plugin(traceAnalyzer, { env: 'test' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

async function fetchTrace(args: Record<string, unknown> = { traceId: 'trace-1' }): Promise<Envelope> {
  const tool = ctx.tools.get('sentry_fetch_trace')
  if (tool === undefined) throw new Error('sentry_fetch_trace not registered')
  return await tool.execute(args, {} as never) as Envelope
}

describe('tool-trace-analyzer TraceStore Consumer', () => {
  it('passes backend-neutral intent to the Definition and uses its identity', async () => {
    const output = await fetchTrace({
      traceId: 'trace-1',
      start: 'now-1h',
      end: 'now',
      service: 'checkout',
      operation: 'GET /orders',
    })

    expect(store.requests).toEqual([{
      traceId: 'trace-1',
      start: 'now-1h',
      end: 'now',
      service: 'checkout',
      operation: 'GET /orders',
    }])
    expect(output.evidence.data).toMatchObject({
      trace_id: 'trace-1',
      backend_ref: 'fake:trace-backend',
      duration_ms: 125,
      services: ['checkout'],
    })
    expect(output.evidence.data).not.toHaveProperty('datasource_uid')
    expect(output.evidence.data).not.toHaveProperty('endpoint')
    expect(output.evidence.refs?.[0]).toBe('fake:trace-backend')
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    store.error = new Error('backend unavailable')
    const output = await fetchTrace()

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:trace-backend',
      error: 'backend unavailable',
    })
  })
})
