import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  CallflowStore,
  DEFAULT_CALLFLOW_LIMIT,
  DEFAULT_CALLFLOW_LOOKBACK_MS,
  summarizeCallFlow,
  type CallflowQueryRequest,
  type CallflowQueryResult,
} from '../src/index.ts'

class FakeCallflowStore extends CallflowStore {
  override get backendRef(): string {
    return 'fake:callflow'
  }

  override async queryCallFlow(request: CallflowQueryRequest): Promise<CallflowQueryResult> {
    const messages = [{ sip_method: 'INVITE', call_id: request.callId }]
    return {
      start: request.start ?? 'start',
      end: request.end ?? 'end',
      limit: request.limit ?? DEFAULT_CALLFLOW_LIMIT,
      messages,
      summary: summarizeCallFlow(messages),
    }
  }
}

describe('CallflowStore Definition', () => {
  it('registers a replaceable implementation at ctx.callflowStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeCallflowStore)

    expect(ctx.callflowStore.backendRef).toBe('fake:callflow')
    await expect(ctx.callflowStore.queryCallFlow({ callId: 'call-1' })).resolves.toMatchObject({
      summary: { total: 1, method_counts: { INVITE: 1 } },
    })

    await ctx.fiber.dispose()
  })

  it('keeps the pure summary and default window constants backend-neutral', () => {
    expect(DEFAULT_CALLFLOW_LOOKBACK_MS).toBe(24 * 3600 * 1000)
    expect(summarizeCallFlow([])).toMatchObject({ total: 0, milestones: {} })
  })
})
