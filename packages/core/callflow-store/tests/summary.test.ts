import { describe, expect, it } from 'vitest'
import { summarizeCallFlow } from '../src/summary.ts'

/** Row factory: timestamp + sip_method (+ optional trace_id / call_id). */
const msg = (ts: string, sip_method: string, trace_id = '', call_id = ''): Record<string, unknown> => ({
  greptime_timestamp: ts,
  sip_method,
  trace_id,
  call_id,
})

describe('summarizeCallFlow', () => {
  it('full call: milestones, pdd, method counts, distinct trace ids', () => {
    const summary = summarizeCallFlow([
      msg('2026-06-01T10:00:01.000Z', 'BYE', 't-1'),
      msg('2026-06-01T10:00:00.000Z', 'INVITE', 't-1'),
      msg('2026-06-01T10:00:02.000Z', '200', 't-1'),
      msg('2026-06-01T10:00:01.500Z', '180', 't-2'),
    ])
    expect(summary.total).toBe(4)
    expect(summary.first_at).toBe('2026-06-01T10:00:00.000Z')
    expect(summary.last_at).toBe('2026-06-01T10:00:02.000Z')
    expect(summary.method_counts).toEqual({ INVITE: 1, '180': 1, BYE: 1, '200': 1 })
    expect(summary.milestones).toEqual({
      invite_at: '2026-06-01T10:00:00.000Z',
      ringing_at: '2026-06-01T10:00:01.500Z',
      answer_at: '2026-06-01T10:00:02.000Z',
      bye_at: '2026-06-01T10:00:01.000Z',
    })
    expect(summary.pdd_ms).toBe(2000)
    expect(summary.error_responses).toEqual({})
    expect(summary.trace_ids).toEqual(['t-1', 't-2'])
  })

  it('failed call: 403/487 counted as error responses, cancel milestone, no pdd', () => {
    const summary = summarizeCallFlow([
      msg('2026-06-01T10:00:00.000Z', 'INVITE'),
      msg('2026-06-01T10:00:00.200Z', '403'),
      msg('2026-06-01T10:00:00.300Z', 'CANCEL'),
      msg('2026-06-01T10:00:00.400Z', '487'),
    ])
    expect(summary.error_responses).toEqual({ '403': 1, '487': 1 })
    expect(summary.milestones.cancel_at).toBe('2026-06-01T10:00:00.300Z')
    expect(summary.milestones.answer_at).toBeUndefined()
    expect(summary.pdd_ms).toBeUndefined()
  })

  it('register-only flow: a 200 without INVITE is NOT an answer', () => {
    const summary = summarizeCallFlow([
      msg('2026-06-01T10:00:00.000Z', 'REGISTER'),
      msg('2026-06-01T10:00:00.100Z', '401'),
      msg('2026-06-01T10:00:00.200Z', 'REGISTER'),
      msg('2026-06-01T10:00:00.300Z', '200'),
    ])
    expect(summary.milestones).toEqual({})
    expect(summary.pdd_ms).toBeUndefined()
    expect(summary.error_responses).toEqual({})
    expect(summary.method_counts['200']).toBe(1)
  })

  it('cancelled call: the 200 acknowledging the CANCEL is NOT an answer', () => {
    // INVITE → 180 → CANCEL → 200(for the CANCEL) → 487：第一个 200 属于
    // CANCEL 确认，接通判定不得吃进它。
    const summary = summarizeCallFlow([
      msg('2026-06-01T10:00:00.000Z', 'INVITE'),
      msg('2026-06-01T10:00:00.500Z', '180'),
      msg('2026-06-01T10:00:01.000Z', 'CANCEL'),
      msg('2026-06-01T10:00:01.100Z', '200'),
      msg('2026-06-01T10:00:01.200Z', '487'),
    ])
    expect(summary.milestones.answer_at).toBeUndefined()
    expect(summary.pdd_ms).toBeUndefined()
    expect(summary.milestones.cancel_at).toBe('2026-06-01T10:00:01.000Z')
    expect(summary.error_responses).toEqual({ '487': 1 })
  })

  it('counts 183 Session Progress as ringing alongside 180', () => {
    const summary = summarizeCallFlow([
      msg('2026-06-01T10:00:00.000Z', 'INVITE'),
      msg('2026-06-01T10:00:00.500Z', '183'),
      msg('2026-06-01T10:00:01.000Z', '200'),
    ])
    expect(summary.milestones.ringing_at).toBe('2026-06-01T10:00:00.500Z')
  })

  it('surfaces distinct call_ids when the OR-match pulls in multiple calls', () => {
    // 传 trace_id 时 `trace_id = ?` 一侧会带进共享它的其他通话；
    // summary 必须让 agent 察觉混入了几个 call_id（按时间序去重）。
    const summary = summarizeCallFlow([
      msg('2026-06-01T10:00:00.000Z', 'INVITE', 't-shared', 'call-a'),
      msg('2026-06-01T10:00:01.000Z', 'BYE', 't-shared', 'call-a'),
      msg('2026-06-01T09:00:00.000Z', 'INVITE', 't-shared', 'call-b'),
    ])
    expect(summary.total).toBe(3)
    expect(summary.call_ids).toEqual(['call-b', 'call-a'])
  })

  it('empty input yields an empty summary', () => {
    const summary = summarizeCallFlow([])
    expect(summary).toEqual({
      total: 0,
      method_counts: {},
      milestones: {},
      error_responses: {},
      call_ids: [],
      trace_ids: [],
    })
  })
})
