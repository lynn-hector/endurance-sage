import { describe, expect, it } from 'vitest'
import {
  buildEvidence,
  buildEvidenceError,
  isEvidenceEnvelope,
  nowIso,
  validateEvidence,
} from '../src/index.ts'

describe('buildEvidence', () => {
  it('builds a conforming envelope with generated id and timestamp', () => {
    const { evidence } = buildEvidence({
      source: 'log-analyzer',
      type: 'log',
      data: { logs: [] },
      summary: 'env=staging service=demo 返回 0 条日志',
      confidence: 0.8,
      refs: ['config/staging.yml:logs'],
    })
    expect(evidence.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(evidence.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(evidence.source).toBe('log-analyzer')
    expect(evidence.refs).toEqual(['config/staging.yml:logs'])
    expect(evidence.reasoning).toBeUndefined()
  })

  it('keeps reasoning when provided', () => {
    const { evidence } = buildEvidence({
      source: 'agent',
      type: 'inference',
      data: {},
      summary: '推测根因',
      confidence: 0.4,
      reasoning: '日志与指标交叉验证',
    })
    expect(evidence.reasoning).toBe('日志与指标交叉验证')
  })

  it('rejects confidence outside [0, 1]', () => {
    expect(() => buildEvidence({
      source: 'x', type: 'log', data: {}, summary: 's', confidence: 1.5,
    })).toThrow(RangeError)
    expect(() => buildEvidence({
      source: 'x', type: 'log', data: {}, summary: 's', confidence: Number.NaN,
    })).toThrow(RangeError)
  })

  it('accepts types outside the documented list (contract drift is real)', () => {
    const { evidence } = buildEvidence({
      source: 'metrics-inspector', type: 'alert', data: {}, summary: 's', confidence: 1,
    })
    expect(evidence.type).toBe('alert')
  })
})

describe('buildEvidenceError', () => {
  it('builds a zero-confidence envelope carrying data.error', () => {
    const { evidence } = buildEvidenceError({
      source: 'log-analyzer',
      type: 'log',
      error: 'connect timeout',
      summary: '查询失败',
    })
    expect(evidence.confidence).toBe(0)
    expect(evidence.data).toEqual({ error: 'connect timeout' })
    expect(isEvidenceEnvelope({ evidence })).toBe(true)
  })
})

describe('validateEvidence', () => {
  it('accepts builder output', () => {
    const envelope = buildEvidence({
      source: 'x', type: 'db', data: { rows: 3 }, summary: 's', confidence: 0.9,
    })
    expect(validateEvidence(envelope)).toEqual([])
  })

  it('rejects non-object input', () => {
    expect(validateEvidence(null)).toHaveLength(1)
    expect(validateEvidence('evidence')).toHaveLength(1)
    expect(validateEvidence([])).toHaveLength(1)
  })

  it('rejects a missing evidence object', () => {
    expect(validateEvidence({})).toHaveLength(1)
    expect(validateEvidence({ evidence: [] })).toHaveLength(1)
  })

  it('reports every violated field', () => {
    const violations = validateEvidence({
      evidence: {
        id: '',
        source: 42,
        type: '',
        timestamp: 'not-a-date',
        data: [],
        summary: '',
        confidence: 2,
        reasoning: 1,
        refs: ['ok', 1],
      },
    })
    expect(violations.length).toBe(9)
  })
})

describe('nowIso', () => {
  it('emits second-precision UTC', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
})
