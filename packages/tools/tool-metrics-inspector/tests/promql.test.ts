import { describe, expect, it } from 'vitest'
import { buildPromql, metricUnit } from '../src/promql.ts'

/**
 * Golden tests for the rewritten short-name templates (validated live
 * against the cluster: `app` label, Spring HTTP metric names) and the
 * substitution semantics kept from the script era.
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
