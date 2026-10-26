import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AlertmanagerService from '@dsh-sentry/service-alertmanager'
import {
  MetricsStore,
  type AlertRecord,
  type AlertRuleRecord,
  type FiringAlertsQuery,
  type AlertRulesQuery,
  type MetricDataPoint,
  type MetricNamesQuery,
  type MetricsInstantQuery,
  type MetricsRangeQuery,
} from '@dsh-sentry/metrics-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as metricsInspector from '../src/index.ts'

class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(): unknown[] {
    return []
  }

  async assemble(): Promise<{ sections: unknown[] }> {
    return { sections: [] }
  }
}

const POINTS: MetricDataPoint[] = [
  { timestamp: '2026-10-01T00:00:00Z', value: 12.5, labels: { app: 'push' } },
  { timestamp: '2026-10-01T00:15:00Z', value: 13.1, labels: { app: 'push' } },
]

const FIRING: AlertRecord[] = [{
  name: 'GoGrpcP95LatencyHigh',
  state: 'firing',
  severity: 'l2',
  query: 'up == 0',
  duration: 180,
  started_at: '2026-10-10T07:14:53Z',
  labels: { severity: 'l2', app: 'push' },
  annotations: {},
  value: '2.125',
}]

const RULES: AlertRuleRecord[] = [{
  name: 'GoGrpcP95LatencyHigh',
  group: 'GoServiceL2Alerts',
  query: 'up == 0',
  duration: 180,
  labels: { severity: 'l2' },
  annotations: {},
  state: 'firing',
  firing: [],
}]

class FakeMetricsStore extends MetricsStore {
  ranges: MetricsRangeQuery[] = []
  instants: MetricsInstantQuery[] = []
  firingQueries: FiringAlertsQuery[] = []
  ruleQueries: AlertRulesQuery[] = []
  nameQueries: MetricNamesQuery[] = []
  error?: Error
  ready = true

  override get backendRef(): string {
    return 'fake:prometheus/http://localhost:9090'
  }

  override get configured(): boolean {
    return this.ready
  }

  override async queryRangeMetrics(request: MetricsRangeQuery): Promise<MetricDataPoint[]> {
    this.ranges.push(request)
    if (this.error) throw this.error
    return POINTS
  }

  override async queryInstantMetrics(request: MetricsInstantQuery): Promise<MetricDataPoint[]> {
    this.instants.push(request)
    if (this.error) throw this.error
    return POINTS.slice(0, 1)
  }

  override async listFiringAlerts(request: FiringAlertsQuery): Promise<AlertRecord[]> {
    this.firingQueries.push(request)
    if (this.error) throw this.error
    return FIRING
  }

  override async listAlertRules(request: AlertRulesQuery): Promise<AlertRuleRecord[]> {
    this.ruleQueries.push(request)
    if (this.error) throw this.error
    return RULES
  }

  override async listMetricNames(request: MetricNamesQuery): Promise<string[]> {
    this.nameQueries.push(request)
    if (this.error) throw this.error
    return ['http_server_requests_seconds_count', 'up']
  }
}

interface Envelope {
  evidence: {
    // biome-ignore lint: 测试侧宽松取值，形状由断言约束
    data: any
    summary: string
    confidence: number
    refs?: string[]
  }
}

let ctx: Context
let store: FakeMetricsStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeMetricsStore)
  store = ctx.metricsStore as FakeMetricsStore
  await ctx.plugin(AlertmanagerService, { grafanaEndpoint: 'https://grafana.example.invalid' })
  await ctx.plugin(metricsInspector, { env: 'test' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function tool(name: string) {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-metrics-inspector MetricsStore Consumer', () => {
  it('passes backend-neutral intent to the Definition and uses its identity', async () => {
    const output = await tool('sentry_query_metrics').execute({
      metrics: ['qps'],
      service: 'push',
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T00:30:00Z',
      step: '15s',
    }, {} as never) as Envelope

    expect(store.ranges).toEqual([{
      promql: 'sum(rate(http_server_requests_seconds_count{app="push"}[1m]))',
      startSec: 1790812800,
      endSec: 1790814600,
      step: '15s',
    }])
    expect(output.evidence.data.backend_ref).toBe('fake:prometheus/http://localhost:9090')
    expect(output.evidence.data.metrics[0].data_points).toEqual(POINTS)
    // env 标签优先读装配文件（本地仓库渲染出 dev 环境），只断言形状与后端身份
    expect(output.evidence.refs?.[0]).toMatch(/^env:/)
    expect(output.evidence.refs?.[1]).toBe('fake:prometheus/http://localhost:9090')
  })

  it('routes instant queries through queryInstantMetrics with the evaluation time', async () => {
    await tool('sentry_query_metrics').execute({
      metrics: ['cpu'],
      time: '2026-10-01T00:00:00Z',
    }, {} as never)

    expect(store.instants).toEqual([{
      promql: 'rate(process_cpu_seconds_total[1m])',
      timeSec: 1790812800,
    }])
    expect(store.ranges).toEqual([])
  })

  it('keeps Provider failures per metric inside the existing evidence envelope', async () => {
    store.error = new Error('Prometheus HTTP 503: down')
    const output = await tool('sentry_query_metrics').execute({
      metrics: ['qps'],
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T00:30:00Z',
    }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0.5)
    expect(output.evidence.data.metrics[0].error).toBe('Prometheus HTTP 503: down')
    expect(output.evidence.summary).toContain('1 个失败')
  })

  it('lists firing alerts and rules through the seam with passthrough records', async () => {
    const alerts = await tool('sentry_list_alerts').execute({ service: 'push' }, {} as never) as Envelope
    expect(store.firingQueries).toEqual([{ service: 'push' }])
    expect(alerts.evidence.data.alerts).toEqual(FIRING)
    expect(alerts.evidence.data.backend_ref).toBe('fake:prometheus/http://localhost:9090')

    const rules = await tool('sentry_get_alert_rule').execute({ name: 'grpcp95' }, {} as never) as Envelope
    expect(store.ruleQueries).toEqual([{ nameContains: 'grpcp95' }])
    expect(rules.evidence.data.rules).toEqual(RULES)
  })

  it('discovers metric names through listMetricNames', async () => {
    const output = await tool('sentry_list_metrics').execute({ windowMinutes: 30, limit: 100 }, {} as never) as Envelope
    expect(store.nameQueries).toEqual([{ windowMinutes: 30, limit: 100 }])
    expect(output.evidence.data.metrics).toEqual(['http_server_requests_seconds_count', 'up'])
  })

  it('dry-run shows the neutral request plus backend identity, no transport URL', async () => {
    const output = await tool('sentry_query_metrics').execute({
      metrics: ['qps'],
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T00:30:00Z',
      dryRun: true,
    }, {} as never) as Envelope

    expect(store.ranges).toEqual([])
    expect(output.evidence.data.requests).toEqual([{
      query: 'sum(rate(http_server_requests_seconds_count[1m]))',
      mode: 'range',
      start_sec: 1790812800,
      end_sec: 1790814600,
      step: '15s',
    }])
    expect(output.evidence.data.requests[0]).not.toHaveProperty('url')
    expect(output.evidence.data.backend_ref).toBe('fake:prometheus/http://localhost:9090')
  })

  it('honors the availability contract: demo never crosses a half-configured Provider', async () => {
    store.ready = false
    const output = await tool('sentry_query_metrics').execute({
      metrics: ['qps'],
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T00:30:00Z',
      demo: true,
    }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(String(output.evidence.data.error)).toContain('endpoint')
  })
})
