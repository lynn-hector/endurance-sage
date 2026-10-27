import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrometheusService } from '../src/index.ts'

/**
 * Seam-level Provider tests: the real PrometheusService occupies the
 * backend-neutral ctx.metricsStore slot and its Definition methods return
 * the parsed shapes Consumers depend on. Transport-level behavior (URL
 * construction, auth, retry) is covered by prometheus.test.ts / proxy.test.ts.
 */

const MATRIX_RESPONSE = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [
      { metric: { __name__: 'up', job: 'node' }, values: [[1784714400, '1'], [1784714401, 'NaN']] },
    ],
  },
}

const RULES_RESPONSE = {
  status: 'success',
  data: {
    groups: [{
      name: 'g',
      rules: [{
        type: 'alerting',
        name: 'R',
        query: 'up == 0',
        duration: 120,
        state: 'firing',
        labels: {},
        alerts: [{ labels: { severity: 'l1' }, annotations: {}, activeAt: 't', value: '1' }],
      }],
    }],
  },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('PrometheusService MetricsStore seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('occupies ctx.metricsStore and reports mode-aware identity and availability', async () => {
    const ctx = new Context()
    await ctx.plugin(PrometheusService, { grafanaEndpoint: 'https://grafana.example.invalid/' })
    expect(ctx.metricsStore).toBeInstanceOf(PrometheusService)
    expect(ctx.metricsStore.backendRef).toBe('grafana:https://grafana.example.invalid/datasources/uid/prometheus')
    expect(ctx.metricsStore.configured).toBe(true)
    await ctx.fiber.dispose()

    const direct = new Context()
    await direct.plugin(PrometheusService, { endpoint: 'http://localhost:9090' })
    expect(direct.metricsStore.backendRef).toBe('prometheus:http://localhost:9090')
    expect(direct.metricsStore.configured).toBe(true)
    await direct.fiber.dispose()

    const bare = new Context()
    await bare.plugin(PrometheusService, {})
    expect(bare.metricsStore.configured).toBe(false)
    await bare.fiber.dispose()
  })
  it('returns extracted data points from a range query through the seam', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(MATRIX_RESPONSE)))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(PrometheusService, { endpoint: 'http://localhost:9090' })
    const points = await ctx.metricsStore.queryRangeMetrics({ promql: 'up', startSec: 1, endSec: 2, step: '15s' })

    expect(points).toEqual([
      { timestamp: '2026-07-22T10:00:00Z', value: 1, labels: { __name__: 'up', job: 'node' } },
    ])
    await ctx.fiber.dispose()
  })

  it('surfaces a non-success envelope as a thrown Error with backend wording', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ status: 'error', error: 'query parse error' })))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(PrometheusService, { endpoint: 'http://localhost:9090' })
    await expect(ctx.metricsStore.queryRangeMetrics({ promql: 'up{', startSec: 1, endSec: 2, step: '15s' }))
      .rejects.toThrow('query parse error')
    await ctx.fiber.dispose()
  })

  it('maps rules onto firing alerts and rule records through the seam', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(RULES_RESPONSE)))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(PrometheusService, { endpoint: 'http://localhost:9090' })
    const alerts = await ctx.metricsStore.listFiringAlerts({})
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ name: 'R', state: 'firing', duration: 120 })

    const rules = await ctx.metricsStore.listAlertRules({ nameContains: 'r' })
    expect(rules).toHaveLength(1)
    expect(rules[0]!.query).toBe('up == 0')
    await ctx.fiber.dispose()
  })
})
