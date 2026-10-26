import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MqStore, type MqMessageDetailResult, type MqMessageListRequest, type MqMessageListResult } from '../src/index.ts'

class FakeMqStore extends MqStore {
  lists: MqMessageListRequest[] = []

  override get backendRef(): string {
    return 'fake:rocketmq-console/https://rocketmq.example.com'
  }

  override async queryMessages(request: MqMessageListRequest): Promise<MqMessageListResult> {
    this.lists.push(request)
    return {
      status: 0,
      errMsg: null,
      taskId: undefined,
      truncated: false,
      scanned: 1,
      totalElements: 1,
      totalPages: 1,
      messages: [{ msgId: 'M1' }],
      raw: { status: 0 },
    }
  }

  override async queryMessageDetail(request: { topic: string, msgId: string }): Promise<MqMessageDetailResult> {
    return {
      status: 0,
      errMsg: null,
      messageView: { msgId: request.msgId },
      messageTrackList: [],
      raw: { status: 0 },
    }
  }
}

describe('MqStore Definition', () => {
  it('registers a replaceable implementation at ctx.mqStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeMqStore)

    expect(ctx.mqStore.backendRef).toBe('fake:rocketmq-console/https://rocketmq.example.com')
    const result = await ctx.mqStore.queryMessages({ topic: 'topic_user', beginMs: 1, endMs: 2 })
    expect(result.messages).toEqual([{ msgId: 'M1' }])
    const detail = await ctx.mqStore.queryMessageDetail({ topic: 'topic_user', msgId: 'M1' })
    expect(detail.messageView).toEqual({ msgId: 'M1' })

    await ctx.fiber.dispose()
  })
})
