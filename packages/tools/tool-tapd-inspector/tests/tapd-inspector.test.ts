import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TapdService, { type TapdBug, type TapdComment } from '@dsh-sentry/service-tapd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tapdInspector from '../src/index.ts'

/**
 * Fake-Provider contract test: the tool must reach TAPD only through the
 * `ctx.tapd` slot, map model arguments to backend-neutral filters, keep a
 * comment failure from sinking the detail evidence, and never fabricate
 * tickets when the Provider errors.
 */

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

type ListBugsOptions = Parameters<TapdService['listBugs']>[0]

const BUG: TapdBug = {
  id: '1136382267300123456',
  title: '通话中断',
  status: 'in_progress',
  severity: 'High',
  priority: 'High',
  current_owner: 'yangfm',
  reporter: 'tester',
  created: '2026-08-24 10:00:00',
  modified: '2026-08-24 11:00:00',
  description: '现象描述',
  resolution: 'fixed',
  fixer: 'dev1',
}

class FakeTapdService extends TapdService {
  // The real service waits for the credential plane; the fake answers
  // directly and must not gate on it.
  static override inject = []

  lists: ListBugsOptions[] = []
  fetched: string[] = []
  error?: Error
  commentsError?: Error

  override async listBugs(options: ListBugsOptions): Promise<TapdBug[]> {
    this.lists.push(options)
    if (this.error) throw this.error
    return [BUG]
  }

  override async fetchBug(id: string): Promise<TapdBug> {
    this.fetched.push(id)
    if (this.error) throw this.error
    return { ...BUG, id }
  }

  override async listComments(id: string): Promise<TapdComment[]> {
    if (this.commentsError) throw this.commentsError
    return id === BUG.id
      ? [{ author: 'tester', created: '2026-08-24 10:30:00', description: '第一行<br/>第二行' }] as TapdComment[]
      : []
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
let service: FakeTapdService

beforeEach(async () => {
  // Isolate from the machine's real assembly files so config.env ('test') is
  // the env label the evidence carries.
  vi.stubEnv('DSH_SENTRY_ASSEMBLY_DIR', '/nonexistent-assembly-dir')
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeTapdService, { workspaceId: '63822673' })
  service = ctx.tapd as FakeTapdService
  await ctx.plugin(tapdInspector, { env: 'test' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_query_tapd') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-tapd-inspector TapdService Consumer', () => {
  it('lists through the seam with backend-neutral filters', async () => {
    const output = await tool('sentry_query_tapd').execute({
      severity: 'High',
      limit: 50,
    }, {} as never) as Envelope

    expect(service.lists).toEqual([{ severity: 'High', limit: 50 }])
    expect(output.evidence.data).toMatchObject({ env: 'test', mode: 'list', count: 1 })
    expect(output.evidence.refs).toEqual(['env:test:tapd'])
    expect(output.evidence.confidence).toBe(0.9)
  })

  it('detail mode maps the ticket row and strips comment HTML', async () => {
    const output = await tool('sentry_query_tapd').execute({ id: BUG.id }, {} as never) as Envelope

    expect(service.fetched).toEqual([BUG.id])
    expect(output.evidence.data).toMatchObject({
      mode: 'detail',
      ticket: { id: BUG.id, title: '通话中断', resolution: 'fixed' },
      comments: [{ author: 'tester', created: '2026-08-24 10:30:00', text: '第一行\n第二行' }],
    })
    expect(output.evidence.refs).toEqual([`env:test:tapd`, `tapd:bug:${BUG.id}`])
  })

  it('a comment failure degrades comments without sinking the detail', async () => {
    service.commentsError = new Error('TAPD /comments 失败: permission denied')
    const output = await tool('sentry_query_tapd').execute({ id: BUG.id }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0.9)
    expect(output.evidence.data).toMatchObject({
      mode: 'detail',
      comments: [{ error: 'TAPD /comments 失败: permission denied' }],
    })
  })

  it('Provider failures come back as confidence-0 evidence, never tickets', async () => {
    service.error = new Error('TAPD /bugs 失败: permission denied')
    const output = await tool('sentry_query_tapd').execute({ id: BUG.id }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({
      env: 'test',
      error: 'TAPD /bugs 失败: permission denied',
    })
    expect(output.evidence.data).not.toHaveProperty('ticket')
  })
})
