import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { TraceStore, type ParsedTrace, type TraceQueryRequest } from '../src/index.ts'

class FakeTraceStore extends TraceStore {
  override get backendRef(): string {
    return 'fake:trace'
  }

  override async queryTrace(request: TraceQueryRequest): Promise<ParsedTrace> {
    return {
      duration_ms: 0,
      status: 'unknown',
      services: [],
      spans: [],
      slow_spans: [],
      errors: [],
      frames_count: 0,
      raw_response: { traceId: request.traceId },
    }
  }
}

describe('TraceStore Definition', () => {
  it('registers a replaceable implementation at ctx.traceStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeTraceStore)

    expect(ctx.traceStore.backendRef).toBe('fake:trace')
    await expect(ctx.traceStore.queryTrace({ traceId: 'trace-1' })).resolves.toMatchObject({
      status: 'unknown',
      raw_response: { traceId: 'trace-1' },
    })

    await ctx.fiber.dispose()
  })
})
