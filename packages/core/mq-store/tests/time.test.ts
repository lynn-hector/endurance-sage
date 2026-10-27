import { describe, expect, it } from 'vitest'
import { parseTimeMs } from '../src/time.ts'

describe('parseTimeMs — port of _parse_time_ms', () => {
  it('accepts pure-digit milliseconds', () => {
    expect(parseTimeMs('1785081600000')).toBe(1785081600000)
    expect(parseTimeMs(1785081600000)).toBe(1785081600000)
  })

  it('accepts ISO8601 (epoch-true) and defaults', () => {
    expect(parseTimeMs('2026-07-27T08:00:00Z')).toBe(Date.UTC(2026, 6, 27, 8, 0, 0))
    expect(parseTimeMs('2026-07-27T08:00:00')).toBe(Date.UTC(2026, 6, 27, 8, 0, 0))
    expect(parseTimeMs(undefined, 12345)).toBe(12345)
    const before = Date.now()
    expect(parseTimeMs(null)).toBeGreaterThanOrEqual(before)
  })

  it('rejects unparseable text with the original wording', () => {
    expect(() => parseTimeMs('not-a-time')).toThrow('无法解析时间参数: not-a-time')
  })
})
