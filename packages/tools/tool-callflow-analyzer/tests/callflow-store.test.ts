import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  CallflowStore,
  summarizeCallFlow,
  type CallflowQueryRequest,
  type CallflowQueryResult,
} from '@dsh-sentry/callflow-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as callflowAnalyzer from '../src/index.ts'

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

/**
 * Session Provider router stub: leases whatever service this test context
 * mounted globally under a fixed env label. The Session routing itself is
 * covered by tests/session-env.test.ts against the real stack.
 */
class StubEnvProviders extends Service {
  constructor(ctx: Context, private readonly options: { env: string }) {
    super(ctx, 'envProviders')
  }

  async forCall(): Promise<unknown> {
    const ctx = this.ctx
    return {
      env: this.options.env,
      unavailableLegs: [],
      release: async () => {},
      require(slot: string): unknown {
        const instance = ctx.get(slot)
        if (instance === undefined) throw new Error(`stub lease: ${slot} 未加载`)
        return instance
      },
    }
  }
}

const MESSAGES = [
  { greptime_timestamp: '2026-06-01T10:00:00.000Z', sip_method: 'INVITE', call_id: 'call-1', trace_id: 't-1' },
  { greptime_timestamp: '2026-06-01T10:00:02.000Z', sip_method: '200', call_id: 'call-1', trace_id: 't-1' },
]

const RESULT: CallflowQueryResult = {
  start: '2026-06-01T00:00:00Z',
  end: '2026-06-01T23:59:59Z',
  limit: 1000,
  messages: MESSAGES,
  summary: summarizeCallFlow(MESSAGES),
}

class FakeCallflowStore extends CallflowStore {
  requests: CallflowQueryRequest[] = []
  error?: Error

  override get backendRef(): string {
    return 'fake:greptimedb/public'
  }

  override async queryCallFlow(request: CallflowQueryRequest): Promise<CallflowQueryResult> {
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
let store: FakeCallflowStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeCallflowStore)
  store = ctx.callflowStore as FakeCallflowStore
  await ctx.plugin(StubEnvProviders, { env: 'test' })
  await ctx.plugin(callflowAnalyzer)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('tool-callflow-analyzer CallflowStore Consumer', () => {
  it('passes call intent to the Definition and keeps the summary in evidence', async () => {
    const output = await ctx.tools.get('sentry_query_call_flow')!.execute({
      callId: ' call-1 ',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-01T23:59:59Z',
      limit: 1000,
    }, {} as never) as Envelope

    expect(store.requests).toEqual([{
      callId: 'call-1',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-01T23:59:59Z',
      limit: 1000,
    }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:greptimedb/public',
      call_id: 'call-1',
      messages: MESSAGES,
      summary: expect.objectContaining({ total: 2, pdd_ms: 2000 }),
    })
    expect(output.evidence.data).not.toHaveProperty('sql')
    expect(output.evidence.refs?.[0]).toBe('fake:greptimedb/public')
  })

  it('rejects an empty callId before reaching the Provider', async () => {
    const output = await ctx.tools.get('sentry_query_call_flow')!.execute({ callId: '  ' }, {} as never) as Envelope
    expect(store.requests).toEqual([])
    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'callId 不能为空' })
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    store.error = new Error('signaling backend unavailable')
    const output = await ctx.tools.get('sentry_query_call_flow')!.execute({ callId: 'call-1' }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'signaling backend unavailable' })
  })
})
