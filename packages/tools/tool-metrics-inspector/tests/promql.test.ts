import { describe, expect, it } from 'vitest'
import {
  buildPromql,
  extractAlertRules,
  extractFiringAlerts,
  extractInstantDataPoints,
  metricUnit,
  type AlertRecord,
  type AlertRuleRecord,
} from '../src/promql.ts'

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

describe('extractFiringAlerts — rule query and duration fields', () => {
  const RULES_RESPONSE = {
    status: 'success',
    data: {
      groups: [{
        name: 'GoServiceL2Alerts',
        rules: [{
          type: 'alerting',
          name: 'GoGrpcP95LatencyHigh',
          query: 'histogram_quantile(0.95, sum by (le, grpc_service, grpc_method) (rate(grpc_server_handling_seconds_bucket{namespace="novo-one"}[5m]))) > 1',
          duration: 180,
          state: 'firing',
          labels: { severity: 'l2' },
          alerts: [{
            labels: { severity: 'l2', grpc_service: 'com.yeastar.novoone.cconfig.DialplanService' },
            annotations: { summary: 'Go gRPC P95 耗时过高' },
            activeAt: '2026-10-10T07:14:53Z',
            value: '2.125',
          }],
        }, {
          type: 'alerting',
          name: 'NoDurationRule',
          query: 'up == 0',
          state: 'firing',
          labels: { severity: 'l2' },
          alerts: [{ labels: { severity: 'l2' }, annotations: {}, activeAt: '2026-10-10T07:00:00Z', value: '1' }],
        }],
      }],
    },
  }

  it('carries the rule expression and for-duration on each alert', () => {
    // Tuple casts keep destructured elements non-undefined under the repo's
    // `noUncheckedIndexedAccess` (same pattern as lastCall in service tests).
    const [first, second] = extractFiringAlerts(RULES_RESPONSE) as [AlertRecord, AlertRecord]
    expect(first.query).toBe(RULES_RESPONSE.data.groups[0]?.rules[0]?.query)
    expect(first.duration).toBe(180)
    expect(second.duration).toBeNull()  // duration 缺失 → null
  })

  it('yields null query when the rule record lacks one', () => {
    const noQuery = structuredClone(RULES_RESPONSE)
    delete (noQuery.data.groups[0]?.rules[0] as Record<string, unknown> | undefined)?.query
    const [alert] = extractFiringAlerts(noQuery) as [AlertRecord]
    expect(alert.query).toBeNull()
  })

  it('yields null duration when the rule duration is not a finite number', () => {
    const garbage = structuredClone(RULES_RESPONSE)
    const [rule] = garbage.data.groups[0]?.rules as unknown as [Record<string, unknown>]
    rule.duration = 'not-a-number'
    const [alert] = extractFiringAlerts(garbage) as [AlertRecord]
    expect(alert.duration).toBeNull()  // NaN → null
  })
})

describe('extractAlertRules — full rule lookup by name substring', () => {
  const RULES_RESPONSE = {
    status: 'success',
    data: {
      groups: [{
        name: 'CommonBusinessAlerts',
        rules: [{
          type: 'recording',
          name: 'not-an-alert',
          query: 'sum(up)',
        }, {
          type: 'alerting',
          name: 'gRPCP95LatencyHigh',
          query: 'grpc_server_processing_duration_seconds{quantile="0.95"} > 3',
          duration: 0,
          state: 'inactive',
          labels: { severity: 'l1' },
          annotations: { summary: 's1' },
        }],
      }, {
        name: 'CommonBusinessL2Alerts',
        rules: [{
          type: 'alerting',
          name: 'gRPCP95LatencyHigh',
          query: 'increase(grpc_server_processing_duration_seconds_sum[1m]) / increase(grpc_server_processing_duration_seconds_count[1m]) > 5',
          duration: 120,
          state: 'firing',
          labels: { severity: 'l2' },
          annotations: { summary: 's2' },
          alerts: [{ labels: { service: 'x' }, annotations: {}, activeAt: '2026-10-10T07:00:00Z', value: '6.1' }],
        }],
      }],
    },
  }

  it('matches case-insensitively across groups, keeping inactive rules and recording rules out', () => {
    const rules = extractAlertRules(RULES_RESPONSE, 'grpcp95')
    expect(rules).toHaveLength(2)
    expect(rules[0]!.group).toBe('CommonBusinessAlerts')
    expect(rules[0]!.state).toBe('inactive')
    expect(rules[0]!.firing).toEqual([])
    expect(rules[1]!.group).toBe('CommonBusinessL2Alerts')
    expect(rules[1]!.duration).toBe(120)
    expect(rules[1]!.firing[0]!.value).toBe('6.1')
  })

  it('returns every alerting rule when no filter is given', () => {
    expect(extractAlertRules(RULES_RESPONSE)).toHaveLength(2)
  })

  it('throws on non-success envelope like extractFiringAlerts', () => {
    expect(() => extractAlertRules({ status: 'error', error: 'boom' })).toThrow('boom')
  })
})

describe('extractInstantDataPoints — vector envelope', () => {
  it('converts each vector series into one data point', () => {
    const VECTOR = {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { grpc_service: 'svc-a', grpc_method: 'm1' }, value: [1784714400, '2.125'] },
          { metric: { grpc_service: 'svc-b' }, value: [1784714400, 'NaN'] },
        ],
      },
    }
    const points = extractInstantDataPoints(VECTOR)
    expect(points).toEqual([
      { timestamp: '2026-07-22T10:00:00Z', value: 2.125, labels: { grpc_service: 'svc-a', grpc_method: 'm1' } },
    ])
  })

  it('returns [] for non-vector envelopes', () => {
    expect(extractInstantDataPoints({ status: 'success', data: { resultType: 'matrix', result: [] } })).toEqual([])
  })
})

describe('duration 的 JSON null / 空串不被 Number() 成 0（回归：曾报成真实的 for 0s）', () => {
  const withDuration = (duration: unknown) => ({
    status: 'success',
    data: { groups: [{ name: 'g', rules: [{
      type: 'alerting', name: 'R', query: 'up == 0', state: 'firing', duration,
      labels: {}, alerts: [{ labels: {}, annotations: {}, activeAt: 't', value: '1' }],
    }] }] },
  })

  it('extractFiringAlerts：duration null 与空串都报 null，不报 0', () => {
    for (const bad of [null, '']) {
      const [alert] = extractFiringAlerts(withDuration(bad)) as [AlertRecord]
      expect(alert.duration, `duration=${JSON.stringify(bad)}`).toBeNull()
    }
  })

  it('extractAlertRules：同型——null 与空串都报 null', () => {
    for (const bad of [null, '']) {
      const [rule] = extractAlertRules(withDuration(bad)) as [AlertRuleRecord]
      expect(rule.duration, `duration=${JSON.stringify(bad)}`).toBeNull()
    }
  })
})
