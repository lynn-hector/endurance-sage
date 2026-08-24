import { describe, expect, it } from 'vitest'
import { extractLogPatterns } from '../src/patterns.ts'

function log(message: string, timestamp: string): Record<string, unknown> {
  return { message, greptime_timestamp: timestamp }
}

describe('extractLogPatterns', () => {
  it('aggregates by the 80-char message fingerprint, top counts first', () => {
    const logs = [
      log('ERROR connection refused to db', 't1'),
      log('INFO health check ok', 't2'),
      log('ERROR connection refused to db', 't3'),
      log('ERROR connection refused to db', 't5'),
      log('INFO health check ok', 't4'),
    ]
    const patterns = extractLogPatterns(logs)
    expect(patterns).toEqual([
      { pattern: 'ERROR connection refused to db', count: 3, first_at: 't1', last_at: 't5' },
      { pattern: 'INFO health check ok', count: 2, first_at: 't2', last_at: 't4' },
    ])
  })

  it('truncates the fingerprint at the configured length', () => {
    const head = 'x'.repeat(79)
    const logs = [log(`${head}A`, 't1'), log(`${head}B`, 't2')]
    const patterns = extractLogPatterns(logs)
    // 79 shared chars + 1 differing char → two distinct 80-char fingerprints
    expect(patterns).toHaveLength(2)
    const merged = extractLogPatterns(logs, { fingerprintLength: 79 })
    expect(merged).toEqual([{ pattern: head, count: 2, first_at: 't1', last_at: 't2' }])
  })

  it('caps the result at topN', () => {
    const logs = Array.from({ length: 8 }, (_, i) => log(`pattern ${i}`, `t${i}`))
    expect(extractLogPatterns(logs)).toHaveLength(5)
    expect(extractLogPatterns(logs, { topN: 3 })).toHaveLength(3)
  })

  it('handles missing message/timestamp fields as empty strings', () => {
    const patterns = extractLogPatterns([{}])
    expect(patterns).toEqual([{ pattern: '', count: 1, first_at: '', last_at: '' }])
  })
})
