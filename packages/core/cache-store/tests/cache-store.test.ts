import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CacheStore, type CacheEntry, type CacheGetRequest } from '../src/index.ts'

class FakeCacheStore extends CacheStore {
  lookups: CacheGetRequest[] = []

  override get backendRef(): string {
    return 'fake:dbx/https://dbx.example.com'
  }

  override async getValue(request: CacheGetRequest): Promise<CacheEntry> {
    this.lookups.push(request)
    return {
      key: request.key,
      db: request.db,
      connectionId: 'conn-redis-1',
      keyDisplay: request.key,
      keyRaw: null,
      ttl: 300,
      redisType: 'string',
      value: 'cached',
      valueEncoding: 'utf8',
      valueRawBase64: null,
      raw: {},
    }
  }
}

describe('CacheStore Definition', () => {
  it('registers a replaceable implementation at ctx.cacheStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeCacheStore)

    expect(ctx.cacheStore.backendRef).toBe('fake:dbx/https://dbx.example.com')
    const entry = await ctx.cacheStore.getValue({ key: 'session:user:1', db: 3 })
    expect(entry).toMatchObject({ key: 'session:user:1', db: 3, connectionId: 'conn-redis-1', value: 'cached' })

    await ctx.fiber.dispose()
  })
})
