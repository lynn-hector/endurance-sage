import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { DbStore, type DbQueryRequest, type DbQueryResult } from '../src/index.ts'

class FakeDbStore extends DbStore {
  queries: DbQueryRequest[] = []

  override get backendRef(): string {
    return 'fake:dbx/https://dbx.example.com'
  }

  override async querySql(request: DbQueryRequest): Promise<DbQueryResult> {
    this.queries.push(request)
    return {
      database: request.database,
      connectionId: 'conn-pg-1',
      results: [{ columns: ['probe'], rows: [[1]] }],
    }
  }
}

describe('DbStore Definition', () => {
  it('registers a replaceable implementation at ctx.dbStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeDbStore)

    expect(ctx.dbStore.backendRef).toBe('fake:dbx/https://dbx.example.com')
    const result = await ctx.dbStore.querySql({ sql: 'SELECT 1', database: 'novo_cfg' })
    expect(result.database).toBe('novo_cfg')
    expect(result.connectionId).toBe('conn-pg-1')
    expect(result.results).toHaveLength(1)

    await ctx.fiber.dispose()
  })
})
