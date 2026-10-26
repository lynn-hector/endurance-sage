import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LogStore, type ListLogServicesRequest, type LogQueryRequest, type LogQueryResult } from '../src/index.ts'

class FakeLogStore extends LogStore {
  override get backendRef(): string {
    return 'fake:logs'
  }

  override get logFilterFields(): readonly string[] {
    return ['message', 'level']
  }

  override async queryLogs(request: LogQueryRequest): Promise<LogQueryResult> {
    return { records: [{ message: ` queried ${request.start}-${request.end}` }], timestampField: 'ts' }
  }

  override async listLogServices(_request: ListLogServicesRequest): Promise<string[]> {
    return ['checkout']
  }
}

describe('LogStore Definition', () => {
  it('registers a replaceable implementation at ctx.logStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeLogStore)

    expect(ctx.logStore.backendRef).toBe('fake:logs')
    expect(ctx.logStore.logFilterFields).toEqual(['message', 'level'])
    await expect(ctx.logStore.queryLogs({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }))
      .resolves.toMatchObject({ timestampField: 'ts', records: [{ message: ' queried 2026-01-01T00:00:00Z-2026-01-01T01:00:00Z' }] })
    await expect(ctx.logStore.listLogServices({})).resolves.toEqual(['checkout'])

    await ctx.fiber.dispose()
  })
})
