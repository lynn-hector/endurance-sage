import { describe, expect, it } from 'vitest'
import { buildPromql, metricUnit, parseIso8601 } from '../src/promql.ts'

/**
 * Golden tests for the rewritten short-name templates (validated live
 * against the cluster: `app` label, Spring HTTP metric names) and the
 * substitution semantics kept from the script era. The envelope parsers
 * (extract*) moved to @dsh-sentry/metrics-store with the Definition and are
 * tested there.
 */

describe('buildPromql — rewritten templates', () => {
  it('expands short names with the app label', () => {
    expect(buildPromql('qps', 'push')).toBe(
      'sum(rate(http_server_requests_seconds_count{app="push"}[1m]))',
    )
    expect(buildPromql('latency_p99', 'ai-voice')).toBe(
      'histogram_quantile(0.99, sum by (le) (rate(http_server_requests_seconds_bucket{app="ai-voice"}[1m])))',
    )
    expect(buildPromql('memory', 'commctl-config')).toBe(
      'process_resident_memory_bytes{app="commctl-config"}',
    )
  })

  it('substitutes every %s in error_rate', () => {
    expect(buildPromql('error_rate', 'push')).toBe(
      'sum(rate(http_server_requests_seconds_count{app="push",status=~"5.."}[1m]))'
      + ' / sum(rate(http_server_requests_seconds_count{app="push"}[1m]))',
    )
  })

  it('strips the exact {app="%s"} clause without a service, keeping the script-era quirk on error_rate', () => {
    expect(buildPromql('qps')).toBe('sum(rate(http_server_requests_seconds_count[1m]))')
    // error_rate's clause carries an extra matcher and survives the exact-match strip.
    expect(buildPromql('error_rate')).toContain('{app="%s",status=~"5.."}')
  })

  it('passes custom PromQL through, appending {app="..."} only when brace-free', () => {
    expect(buildPromql('go_goroutines', 'commctl-config')).toBe('go_goroutines{app="commctl-config"}')
    expect(buildPromql('sum(go_goroutines{app="x"})', 'ignored')).toBe('sum(go_goroutines{app="x"})')
  })

  it('units: templates carry their unit, custom PromQL is unknown', () => {
    expect(metricUnit('qps')).toBe('req/s')
    expect(metricUnit('cpu')).toBe('cores')
    expect(metricUnit('sum(up)')).toBe('unknown')
  })
})

describe('parseIso8601 — consumer-side time mapping', () => {
  it('treats naive input as UTC and returns epoch seconds', () => {
    expect(parseIso8601('2026-07-22T10:00:00Z')).toBe(1784714400)
    expect(parseIso8601('2026-10-01T00:00:00')).toBe(parseIso8601('2026-10-01T00:00:00Z'))
    expect(parseIso8601('2026-10-01T08:00:00+08:00')).toBe(parseIso8601('2026-10-01T00:00:00Z'))
  })

  it('keeps the CPython fromisoformat error wording', () => {
    expect(() => parseIso8601('not-a-date')).toThrow("Invalid isoformat string: 'not-a-date'")
  })
})
