import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MqStore, type MqMessageDetailRequest, type MqMessageDetailResult, type MqMessageListRequest, type MqMessageListResult } from '@dsh-sentry/mq-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mqInspector from '../src/index.ts'

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

const LIST_RESULT: MqMessageListResult = {
  status: 0,
  errMsg: null,
  taskId: 'task-1',
  truncated: false,
  scanned: 10,
  totalElements: 1,
  totalPages: 1,
  messages: [{ msgId: 'M1' }],
  raw: { status: 0 },
}

const DETAIL_RESULT: MqMessageDetailResult = {
  status: 0,
  errMsg: null,
  messageView: { msgId: 'M1' },
  messageTrackList: [{ consumerGroup: 'g1', trackType: 'CONSUMED' }],
  raw: { status: 0 },
}

class FakeMqStore extends MqStore {
  lists: MqMessageListRequest[] = []
  details: MqMessageDetailRequest[] = []
  error?: Error

  override get backendRef(): string {
    return 'fake:rocketmq-console/https://rocketmq.example.com'
  }

  override async queryMessages(request: MqMessageListRequest): Promise<MqMessageListResult> {
    this.lists.push(request)
    if (this.error) throw this.error
    return LIST_RESULT
  }

  override async queryMessageDetail(request: MqMessageDetailRequest): Promise<MqMessageDetailResult> {
    this.details.push(request)
    if (this.error) throw this.error
    return DETAIL_RESULT
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
let store: FakeMqStore

beforeEach(async () => {
  // Isolate from the machine's real assembly files so config.env ('test') is
  // the env label the evidence carries.
  vi.stubEnv('DSH_SENTRY_ASSEMBLY_DIR', '/nonexistent-assembly-dir')
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeMqStore)
  store = ctx.mqStore as FakeMqStore
  await ctx.plugin(mqInspector, { env: 'test' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_query_mq') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-mq-inspector MqStore Consumer', () => {
  it('passes backend-neutral list intent to the Definition and uses its identity', async () => {
    const output = await tool('sentry_query_mq').execute({
      topic: 'topic_user',
      begin: '1785081600000',
      end: '1785168000000',
      pageNum: 2,
      pageSize: 5,
      keyword: 'err',
    }, {} as never) as Envelope

    expect(store.lists).toEqual([{
      topic: 'topic_user',
      beginMs: 1785081600000,
      endMs: 1785168000000,
      pageNum: 2,
      pageSize: 5,
      keyword: 'err',
    }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:rocketmq-console/https://rocketmq.example.com',
      row_count: 1,
      messages: [{ msgId: 'M1' }],
    })
    expect(output.evidence.refs?.[0]).toBe('fake:rocketmq-console/https://rocketmq.example.com')
    expect(output.evidence.refs?.[1]).toBe('env:test:mq')
  })

  it('routes msgId mode to the detail seam', async () => {
    const output = await tool('sentry_query_mq').execute({
      topic: 'topic_user',
      msgId: 'M1',
    }, {} as never) as Envelope

    expect(store.lists).toEqual([])
    expect(store.details).toEqual([{ topic: 'topic_user', msgId: 'M1' }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: 'fake:rocketmq-console/https://rocketmq.example.com',
      consumed_groups: ['g1'],
    })
  })

  it('dry-run returns the neutral request without touching the seam', async () => {
    const output = await tool('sentry_query_mq').execute({
      topic: 'topic_user',
      msgId: 'M1',
      dryRun: true,
    }, {} as never) as Envelope

    expect(store.details).toEqual([])
    expect(store.lists).toEqual([])
    expect(output.evidence.data).toMatchObject({
      dry_run: true,
      backend_ref: 'fake:rocketmq-console/https://rocketmq.example.com',
      request: { mode: 'detail', topic: 'topic_user', msg_id: 'M1' },
    })
    expect(output.evidence.data).not.toHaveProperty('url')
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    store.error = new Error('RocketMQ Console HTTP 500: boom')
    const output = await tool('sentry_query_mq').execute({ topic: 'topic_user' }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'RocketMQ Console HTTP 500: boom' })
  })
})
