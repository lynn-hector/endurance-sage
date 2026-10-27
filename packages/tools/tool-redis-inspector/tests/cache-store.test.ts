import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CacheStore, type CacheEntry, type CacheGetRequest } from '@dsh-sentry/cache-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as redisInspector from '../src/index.ts'

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

const ENTRY: CacheEntry = {
  key: 'session:user:1',
  db: 3,
  connectionId: 'conn-redis-1',
  keyDisplay: 'session:user:1',
  keyRaw: 'a2V5',
  ttl: 300,
  redisType: 'string',
  value: { tenant: 'a' },
  valueEncoding: 'utf8',
  valueRawBase64: Buffer.from('{"tenant":"a"}', 'utf8').toString('base64'),
  raw: { key_display: 'session:user:1', ttl: 300 },
}

class FakeCacheStore extends CacheStore {
  lookups: CacheGetRequest[] = []
  error?: Error

  override get backendRef(): string {
    return 'fake:dbx/https://dbx.example.com'
  }

  override async getValue(request: CacheGetRequest): Promise<CacheEntry> {
    this.lookups.push(request)
    if (this.error) throw this.error
    return { ...ENTRY, key: request.key, db: request.db }
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
let store: FakeCacheStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeCacheStore)
  store = ctx.cacheStore as FakeCacheStore
  await ctx.plugin(StubEnvProviders, { env: 'test' })
  await ctx.plugin(redisInspector, { db: 3 })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_query_redis') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-redis-inspector CacheStore Consumer', () => {
  it('passes backend-neutral intent to the Definition and surfaces the decoded entry', async () => {
    const output = await tool('sentry_query_redis').execute(
      { key: 'session:user:1', db: 0 },
      {} as never,
    ) as Envelope

    expect(store.lookups).toEqual([{ key: 'session:user:1', db: 0 }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:dbx/https://dbx.example.com',
      key: 'session:user:1',
      db: 0,
      connection_id: 'conn-redis-1',
      ttl: 300,
      redis_type: 'string',
      value: { tenant: 'a' },
      value_encoding: 'utf8',
      raw_response: ENTRY.raw,
    })
    expect(output.evidence.data).not.toHaveProperty('url')
    expect(output.evidence.data).not.toHaveProperty('headers')
    expect(output.evidence.refs?.[0]).toBe('fake:dbx/https://dbx.example.com')
  })

  it('falls back to the configured default db index', async () => {
    await tool('sentry_query_redis').execute({ key: 'session:user:1' }, {} as never)

    expect(store.lookups).toEqual([{ key: 'session:user:1', db: 3 }])
  })

  it('dry-run returns the neutral request without touching the seam', async () => {
    const output = await tool('sentry_query_redis').execute(
      { key: 'session:user:1', dryRun: true },
      {} as never,
    ) as Envelope

    expect(store.lookups).toEqual([])
    expect(output.evidence.data).toMatchObject({
      dry_run: true,
      backend_ref: 'fake:dbx/https://dbx.example.com',
      key: 'session:user:1',
      db: 3,
    })
    expect(output.evidence.data).not.toHaveProperty('url')
    expect(output.evidence.data).not.toHaveProperty('headers')
    expect(output.evidence.data).not.toHaveProperty('body')
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    store.error = new Error('dbx HTTP 401: expired')
    const output = await tool('sentry_query_redis').execute({ key: 'session:user:1' }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'dbx HTTP 401: expired' })
  })
})
