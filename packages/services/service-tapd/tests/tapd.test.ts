import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TapdService, { type Config } from '../src/index.ts'

/**
 * Golden tests over a canned fetch: envelope enforcement (status!=1 → error
 * with TAPD's info text), filter → query-param mapping, pagination caps,
 * and the detail unwrap of TAPD's nested {data:{data:[...]}} shapes.
 */

interface Call { path: string; params: URLSearchParams }

function makeService(handler: (call: Call) => { status: number; data?: unknown; info?: string }): TapdService {
  const ctx = new Context()
  const config: Config = { workspaceId: '63822673', token: 't0k3n' }
  const service = new TapdService(ctx, config)
  // intercept fetch via the service's private getJson by stubbing global fetch
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url))
    const call: Call = { path: u.pathname, params: u.searchParams }
    const payload = handler(call)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  ;(service as unknown as { __restore: () => void }).__restore = () => {
    globalThis.fetch = original
  }
  return service
}

function cleanup(service: TapdService): void {
  ;(service as unknown as { __restore?: () => void }).__restore?.()
}

describe('TapdService envelope', () => {
  it('status 1 passes through; nested data unwrapped', async () => {
    const svc = makeService((call) => {
      if (call.path === '/bugs/count') return { status: 1, data: { count: 4684 } }
      throw new Error('unexpected path')
    })
    expect(await svc.count()).toBe(4684)
    cleanup(svc)
  })

  it('status 403 surfaces the TAPD permission text as an error', async () => {
    const svc = makeService(() => ({
      status: 403,
      info: "user 1028736527 doesn't have permission bugs::list of workspace 63822673",
    }))
    await expect(svc.listBugs()).rejects.toThrow(/doesn't have permission bugs::list/)
    cleanup(svc)
  })

  it('non-JSON body degrades to an info error instead of crashing', async () => {
    const ctx = new Context()
    const svc = new TapdService(ctx, { workspaceId: 'w', token: 't' })
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('<html>gateway</html>')) as typeof fetch
    await expect(svc.count()).rejects.toThrow(/TAPD .* 失败/)
    globalThis.fetch = original
  })
})

describe('TapdService listBugs mapping', () => {
  it('time window → created range; owner → current_owner; limit capped at 200', async () => {
    let seen: Call | undefined
    const svc = makeService((call) => {
      seen = call
      return { status: 1, data: { data: [] } }
    })
    await svc.listBugs({
      owner: 'yangfm',
      createdStart: '2026-08-24',
      createdEnd: '2026-08-25',
      limit: 999,
    })
    expect(seen!.params.get('workspace_id')).toBe('63822673')
    expect(seen!.params.get('current_owner')).toBe('yangfm')
    expect(seen!.params.get('created')).toBe('2026-08-24..2026-08-25')
    expect(Number(seen!.params.get('limit'))).toBe(200)
    expect(seen!.params.get('order')).toBe('modified desc')
    cleanup(svc)
  })

  it('severity/status filters and both list envelope shapes', async () => {
    const flat = makeService(() => ({ status: 1, data: [{ id: '1', title: 't', status: 'new' }] }))
    expect((await flat.listBugs({ severity: 'High' }))[0]!.id).toBe('1')
    cleanup(flat)
    const nested = makeService(() => ({ status: 1, data: { data: [{ id: '2' }] } }))
    expect((await nested.listBugs())[0]!.id).toBe('2')
    cleanup(nested)
  })
})

describe('TapdService fetchBug', () => {
  it('unwraps the nested detail and passes the id', async () => {
    let seen: Call | undefined
    const svc = makeService((call) => {
      seen = call
      return { status: 1, data: { data: { id: '113', title: 'x', description: 'd' } } }
    })
    const bug = await svc.fetchBug('113')
    expect(bug.description).toBe('d')
    expect(seen!.params.get('id')).toBe('113')
    expect(seen!.params.get('fields')).toContain('description')
    cleanup(svc)
  })

  it('missing id in the payload throws the not-found wording', async () => {
    const svc = makeService(() => ({ status: 1, data: {} }))
    await expect(svc.fetchBug('999')).rejects.toThrow(/不存在或无权查看/)
    cleanup(svc)
  })
})
