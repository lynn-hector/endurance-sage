import { describe, expect, it } from 'vitest'
import { extractAmAlerts, extractAmSilences } from '../src/am.ts'

const AM_ALERTS = [{
  labels: { alertname: 'GoGrpcP95LatencyHigh', severity: 'l2', cluster: 'dev-platform-hosted-1' },
  annotations: { summary: 'Go gRPC P95 耗时过高' },
  startsAt: '2026-10-10T07:14:53.123Z',
  endsAt: '2026-10-10T07:44:53.123Z',
  fingerprint: '213abc',
  status: { state: 'active', inhibitedBy: [], silencedBy: [] },
  receivers: [{ name: 'feishu-ops' }],
}]

describe('extractAmAlerts', () => {
  it('maps camelCase v2 fields to snake_case records', () => {
    const [alert] = extractAmAlerts(AM_ALERTS)
    expect(alert).toEqual({
      name: 'GoGrpcP95LatencyHigh',
      status: { state: 'active', inhibited_by: [], silenced_by: [] },
      labels: AM_ALERTS[0]!.labels,
      annotations: AM_ALERTS[0]!.annotations,
      active_at: '2026-10-10T07:14:53.123Z',
      ends_at: '2026-10-10T07:44:53.123Z',
      fingerprint: '213abc',
      receivers: ['feishu-ops'],
    })
  })

  it('filters by case-insensitive alertname substring', () => {
    expect(extractAmAlerts(AM_ALERTS, 'grpcP95')).toHaveLength(1)
    expect(extractAmAlerts(AM_ALERTS, 'nope')).toEqual([])
  })

  it('tolerates a non-array payload', () => {
    expect(extractAmAlerts({ odd: true })).toEqual([])
  })
})

const AM_SILENCES = [{
  id: 'sil-1',
  status: { state: 'active' },
  matchers: [{ name: 'cluster', value: 'dev-platform-hosted-1', isRegex: false }],
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-10-20T00:00:00Z',
  comment: '升级窗口静默',
  createdBy: 'ops',
}]

describe('extractAmSilences', () => {
  it('maps fields and filters by state', () => {
    const [silence] = extractAmSilences(AM_SILENCES, 'active')
    expect(silence).toEqual({
      id: 'sil-1',
      status: { state: 'active' },
      matchers: [{ name: 'cluster', value: 'dev-platform-hosted-1', is_regex: false }],
      starts_at: '2026-10-01T00:00:00Z',
      ends_at: '2026-10-20T00:00:00Z',
      comment: '升级窗口静默',
      created_by: 'ops',
    })
    expect(extractAmSilences(AM_SILENCES, 'expired')).toEqual([])
  })

  it('returns everything without a state filter', () => {
    expect(extractAmSilences(AM_SILENCES)).toHaveLength(1)
  })
})
