import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DbStore, type DbQueryRequest, type DbQueryResult } from '@dsh-sentry/db-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as dbInspector from '../src/index.ts'

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

const RESULT_SET = { columns: ['id', 'name'], column_types: ['int4', 'text'], rows: [[1, 'a']], execution_time_ms: 3, truncated: false, affected_rows: 0 }

class FakeDbStore extends DbStore {
  queries: DbQueryRequest[] = []
  error?: Error

  override get backendRef(): string {
    return 'fake:dbx/https://dbx.example.com'
  }

  override async querySql(request: DbQueryRequest): Promise<DbQueryResult> {
    this.queries.push(request)
    if (this.error) throw this.error
    return { database: request.database, connectionId: 'conn-pg-1', results: [RESULT_SET] }
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
let store: FakeDbStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeDbStore)
  store = ctx.dbStore as FakeDbStore
  await ctx.plugin(StubEnvProviders, { env: 'test' })
  await ctx.plugin(dbInspector, { database: 'novo_cfg' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_query_db') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-db-inspector DbStore Consumer', () => {
  it('passes backend-neutral intent to the Definition and uses its identity', async () => {
    const output = await tool('sentry_query_db').execute(
      { sql: 'SELECT id, name FROM t LIMIT 1', database: 'other_db', maxRows: 50 },
      {} as never,
    ) as Envelope

    expect(store.queries).toEqual([{ sql: 'SELECT id, name FROM t LIMIT 1', database: 'other_db', maxRows: 50 }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:dbx/https://dbx.example.com',
      database: 'other_db',
      connection_id: 'conn-pg-1',
      row_count: 1,
      raw_response: [RESULT_SET],
    })
    expect(output.evidence.data).not.toHaveProperty('url')
    expect(output.evidence.data).not.toHaveProperty('headers')
    expect(output.evidence.refs?.[0]).toBe('fake:dbx/https://dbx.example.com')
  })

  it('falls back to the configured default database and maxRows', async () => {
    await tool('sentry_query_db').execute({ sql: 'SELECT 1' }, {} as never)

    expect(store.queries).toEqual([{ sql: 'SELECT 1', database: 'novo_cfg', maxRows: 100 }])
  })

  it('dry-run returns the neutral request without touching the seam', async () => {
    const output = await tool('sentry_query_db').execute(
      { sql: 'SELECT 1', dryRun: true },
      {} as never,
    ) as Envelope

    expect(store.queries).toEqual([])
    expect(output.evidence.data).toMatchObject({
      dry_run: true,
      backend_ref: 'fake:dbx/https://dbx.example.com',
      sql: 'SELECT 1',
      database: 'novo_cfg',
      maxRows: 100,
    })
    expect(output.evidence.data).not.toHaveProperty('url')
    expect(output.evidence.data).not.toHaveProperty('headers')
  })

  it('returns the original missing-database error envelope without calling the seam', async () => {
    const bare = new Context()
    await bare.plugin(StubSystemPrompt)
    await bare.plugin(ToolRuntime)
    await bare.plugin(FakeDbStore)
    await bare.plugin(StubEnvProviders, { env: 'test' })
    await bare.plugin(dbInspector)

    const output = await (bare.tools.get('sentry_query_db')!)
      .execute({ sql: 'SELECT 1' }, {} as never) as Envelope

    expect((bare.dbStore as FakeDbStore).queries).toEqual([])
    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({
      error: 'config/test.yml 中 db.database 或 db.schema 缺失，也可通过 database 参数指定',
    })

    await bare.fiber.dispose()
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    store.error = new Error('dbx HTTP 500: boom')
    const output = await tool('sentry_query_db').execute({ sql: 'SELECT 1' }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'dbx HTTP 500: boom' })
  })
})
