import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  MetricsStore,
  type AlertRulesQuery,
  type AlertRecord,
  type AlertRuleRecord,
  type FiringAlertsQuery,
  type MetricDataPoint,
  type MetricNamesQuery,
  type MetricsInstantQuery,
  type MetricsRangeQuery,
} from '../src/index.ts'

class FakeMetricsStore extends MetricsStore {
  ranges: MetricsRangeQuery[] = []
  instants: MetricsInstantQuery[] = []

  override get backendRef(): string {
    return 'fake:prometheus/http://localhost:9090'
  }

  override get configured(): boolean {
    return true
  }

  override async queryRangeMetrics(request: MetricsRangeQuery): Promise<MetricDataPoint[]> {
    this.ranges.push(request)
    return [{ timestamp: '2026-10-01T00:00:00Z', value: 1, labels: { __name__: 'up' } }]
  }

  override async queryInstantMetrics(request: MetricsInstantQuery): Promise<MetricDataPoint[]> {
    this.instants.push(request)
    return [{ timestamp: '2026-10-01T00:00:00Z', value: 1, labels: { __name__: 'up' } }]
  }

  override async listFiringAlerts(_request: FiringAlertsQuery): Promise<AlertRecord[]> {
    return []
  }

  override async listAlertRules(_request: AlertRulesQuery): Promise<AlertRuleRecord[]> {
    return []
  }

  override async listMetricNames(_request: MetricNamesQuery): Promise<string[]> {
    return ['up']
  }
}

describe('MetricsStore Definition', () => {
  it('registers a replaceable implementation at ctx.metricsStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeMetricsStore)

    expect(ctx.metricsStore.backendRef).toBe('fake:prometheus/http://localhost:9090')
    expect(ctx.metricsStore.configured).toBe(true)
    await expect(ctx.metricsStore.queryRangeMetrics({ promql: 'up', startSec: 1, endSec: 2, step: '15s' }))
      .resolves.toHaveLength(1)
    await expect(ctx.metricsStore.listMetricNames({})).resolves.toEqual(['up'])

    await ctx.fiber.dispose()
  })
})
