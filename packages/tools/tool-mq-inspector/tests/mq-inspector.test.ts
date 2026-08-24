import { detailEvidence, listEvidence } from '../src/index.ts'
import { describe, expect, it } from 'vitest'

/**
 * Golden tests for the evidence aggregation ported from the two branches of
 * `_build_evidence` in `skills/mq-inspector/scripts/inspect.py`: summary
 * wording, consumer-group triage, and confidence on status.
 */

describe('listEvidence — the list-mode branch of _build_evidence', () => {
  it('builds the summary 返回 N 条，共 M 条，K 页 and the pagination payload', () => {
    const evidence = listEvidence('local', {
      topic: 'topic_user',
      beginMs: 1785081600000,
      endMs: 1785168000000,
      pageNum: 1,
      pageSize: 10,
      keyword: '',
    }, {
      status: 0,
      errMsg: null,
      taskId: 'task-1',
      truncated: false,
      scanned: 100,
      totalElements: 42,
      totalPages: 5,
      messages: [{ msgId: 'M1' }, { msgId: 'M2' }, { msgId: 'M3' }],
      raw: { status: 0 },
    }) as unknown as { evidence: { summary: string; data: Record<string, unknown>; confidence: number; source: string; type: string } }

    expect(evidence.evidence.source).toBe('mq-inspector')
    expect(evidence.evidence.type).toBe('mq')
    expect(evidence.evidence.summary).toBe('topic `topic_user` 查询完成，返回 3 条，共 42 条，5 页')
    expect(evidence.evidence.confidence).toBe(0.95)
    expect(evidence.evidence.data['row_count']).toBe(3)
    expect(evidence.evidence.data['begin']).toBe('1785081600000') // ms-as-string like the script
    expect(evidence.evidence.data['begin_ms']).toBe(1785081600000)
    expect(evidence.evidence.data['keyword']).toBe('')
    expect(evidence.evidence.data['raw_response']).toEqual({ status: 0 })
  })

  it('omits missing totals and surfaces errMsg with lowered confidence', () => {
    const evidence = listEvidence('local', {
      topic: 't', beginMs: 1, endMs: 2, pageNum: 1, pageSize: 10, keyword: 'x',
    }, {
      status: 1,
      errMsg: 'topic not exist',
      taskId: undefined,
      truncated: false,
      scanned: 0,
      totalElements: null,
      totalPages: null,
      messages: [],
      raw: { status: 1, errMsg: 'topic not exist' },
    }) as unknown as { evidence: { summary: string; confidence: number } }
    expect(evidence.evidence.summary).toBe('topic `t` 查询完成，返回 0 条，错误信息: topic not exist')
    expect(evidence.evidence.confidence).toBe(0.5)
  })
})

describe('detailEvidence — the detail-mode branch of _build_evidence', () => {
  it('triages consumer groups by trackType and prefers the returned msgId', () => {
    const evidence = detailEvidence('local', 'topic_user', 'M-ARG', {
      status: 0,
      errMsg: null,
      messageView: { msgId: 'M-REAL' },
      messageTrackList: [
        { consumerGroup: 'g1', trackType: 'CONSUMED' },
        { consumerGroup: 'g2', trackType: 'NOT_ONLINE' },
        { consumerGroup: 'g3', trackType: 'CONSUMED_BUT_FILTERED' },
        { consumerGroup: 'g4', trackType: 'UNKNOWN' },
      ],
      raw: { status: 0 },
    }) as unknown as { evidence: { summary: string; data: Record<string, unknown> } }

    expect(evidence.evidence.summary).toBe(
      '消息 `M-REAL` 详情查询完成，已消费组: g1，未在线组: g2，已过滤组: g3',
    )
    expect(evidence.evidence.data['consumed_groups']).toEqual(['g1'])
    expect(evidence.evidence.data['not_online_groups']).toEqual(['g2'])
    expect(evidence.evidence.data['filtered_groups']).toEqual(['g3'])
    expect(evidence.evidence.data['msg_id']).toBe('M-ARG') // the arg is kept; view wins for the summary
  })

  it('falls back to the arg msgId and appends errMsg', () => {
    const evidence = detailEvidence('local', 't', 'M1', {
      status: 1,
      errMsg: 'msg gone',
      messageView: {},
      messageTrackList: [],
      raw: { status: 1 },
    }) as unknown as { evidence: { summary: string } }
    expect(evidence.evidence.summary).toBe('消息 `M1` 详情查询完成，错误信息: msg gone')
  })
})
