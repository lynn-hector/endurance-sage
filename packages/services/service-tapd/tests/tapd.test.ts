import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TapdService, { type Config } from '../src/index.ts'

/**
 * Golden tests over a canned fetch, matching the live-probed wire format
 * (2026-08): endpoint /bugs with `s=mcp` + `Via: mcp` header, response rows
 * wrapped as {Bug: {...}}, envelope enforcement (status!=1 → error with
 * TAPD's info text), short-id padding, and filter → query-param mapping.
 */

interface Call { path: string; params: URLSearchParams; headers: Record<string, string> }

function makeService(handler: (call: Call) => { status: number; data?: unknown; info?: string }): TapdService {
  const ctx = new Context()
  const config: Config = { workspaceId: '63822673', token: 't0k3n' }
  const service = new TapdService(ctx, config)
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const call: Call = {
      path: u.pathname,
      params: u.searchParams,
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    }
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

describe('TapdService envelope and MCP lane', () => {
  it('sends Via: mcp header and s=mcp param on every request', async () => {
    let seen: Call | undefined
    const svc = makeService((call) => {
      seen = call
      return { status: 1, data: [{ Bug: { id: '1', title: 't', status: 'new' } }] }
    })
    await svc.listBugs()
    expect(seen!.headers['via']).toBe('mcp')
    expect(seen!.params.get('s')).toBe('mcp')
    expect(seen!.headers['authorization']).toBe('Bearer t0k3n')
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
  it('hits /bugs with filters; time window → created range; limit capped at 200', async () => {
    let seen: Call | undefined
    const svc = makeService((call) => {
      seen = call
      return { status: 1, data: [] }
    })
    await svc.listBugs({
      owner: 'yangfm',
      createdStart: '2026-08-24',
      createdEnd: '2026-08-25',
      limit: 999,
    })
    expect(seen!.path).toBe('/bugs')
    expect(seen!.params.get('workspace_id')).toBe('63822673')
    expect(seen!.params.get('current_owner')).toBe('yangfm')
    expect(seen!.params.get('created')).toBe('2026-08-24..2026-08-25')
    expect(Number(seen!.params.get('limit'))).toBe(200)
    expect(seen!.params.get('order')).toBe('modified desc')
    cleanup(svc)
  })

  it('unwraps {Bug: {...}} rows (live-probed shape)', async () => {
    const svc = makeService(() => ({
      status: 1,
      data: [{ Bug: { id: '1163822673001160533', title: '外线呼入转录无原文', status: 'in_progress' } }],
    }))
    const bugs = await svc.listBugs()
    expect(bugs[0]!.id).toBe('1163822673001160533')
    expect(bugs[0]!.title).toContain('转录')
    cleanup(svc)
  })
})

describe('TapdService fetchBug', () => {
  it('long id passes through; detail fields requested', async () => {
    let seen: Call | undefined
    const svc = makeService((call) => {
      seen = call
      return { status: 1, data: [{ Bug: { id: '1163822673001160533', description: 'd' } }] }
    })
    const bug = await svc.fetchBug('1163822673001160533')
    expect(bug.description).toBe('d')
    expect(seen!.params.get('id')).toBe('1163822673001160533')
    expect(seen!.params.get('fields')).toContain('description')
    cleanup(svc)
  })

  it('short id is padded to the cloud long format 11<ws><9位序号>', async () => {
    let seen: Call | undefined
    const svc = makeService((call) => {
      seen = call
      return { status: 1, data: [{ Bug: { id: 'x' } }] }
    })
    await svc.fetchBug('1160533')
    expect(seen!.params.get('id')).toBe('1163822673001160533')
    cleanup(svc)
  })

  it('empty result throws the not-found wording', async () => {
    const svc = makeService(() => ({ status: 1, data: [] }))
    await expect(svc.fetchBug('999')).rejects.toThrow(/不存在或无权查看/)
    cleanup(svc)
  })
})
