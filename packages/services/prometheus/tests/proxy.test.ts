import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { framesToQueryRangeEnvelope, PrometheusService } from '../src/index.ts'

/**
 * Golden tests for the grafana-proxy mode: the `/api/ds/query` frames-to-
 * query_range-envelope conversion and the request-body shape. The frames
 * layout follows the Explore query the deployment actually sends
 * (field[0]=Time, field[1]=value with labels).
 */

describe('framesToQueryRangeEnvelope', () => {
  it('converts one frame with labels into a matrix series', () => {
    const envelope = framesToQueryRangeEnvelope({
      results: {
        A: {
          status: 200,
          frames: [{
            schema: {
              fields: [
                { name: 'Time', type: 'time' },
                { name: 'Value', type: 'number', labels: { service: 'order-service', job: 'api' } },
              ],
            },
            data: { values: [[1784714400, 1784714415], [0.12, 0.15]] },
          }],
        },
      },
    }) as { status: string; data: { resultType: string; result: { metric: Record<string, string>; values: [number, string][] }[] } }

    expect(envelope.status).toBe('success')
    expect(envelope.data.resultType).toBe('matrix')
    expect(envelope.data.result).toEqual([
      { metric: { service: 'order-service', job: 'api' }, values: [[1784714400, '0.12'], [1784714415, '0.15']] },
    ])
  })

  it('merges multiple frames and keeps unlabeled series as empty metric', () => {
    const envelope = framesToQueryRangeEnvelope({
      results: {
        A: {
          frames: [
            { schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: { service: 'a' } }] }, data: { values: [[1], [2]] } },
            { schema: { fields: [{ name: 'Time' }, { name: 'Value' }] }, data: { values: [[1, 2], [3, 4]] } },
          ],
        },
      },
    }) as { data: { result: { metric: Record<string, string>; values: [number, string][] }[] } }
    expect(envelope.data.result).toHaveLength(2)
    expect(envelope.data.result[0]?.metric).toEqual({ service: 'a' })
    expect(envelope.data.result[1]?.metric).toEqual({})
    expect(envelope.data.result[1]?.values).toEqual([[1, '3'], [2, '4']])
  })

  it('yields an empty success envelope for unknown shapes', () => {
    for (const payload of [null, {}, { results: null }, { results: { A: {} } }, { results: { A: { frames: [{}] } } }]) {
      const envelope = framesToQueryRangeEnvelope(payload) as { status: string; data: { result: unknown[] } }
      expect(envelope.status).toBe('success')
      expect(envelope.data.result).toEqual([])
    }
  })

  it('skips non-numeric timestamps and pads ragged columns', () => {
    const envelope = framesToQueryRangeEnvelope({
      results: { A: { frames: [{
        schema: { fields: [{ name: 'Time' }, { name: 'Value', labels: {} }] },
        data: { values: [[1, 'x', 3], ['NaN', 5, 6]] },
      }] } },
    }) as { data: { result: { values: [number, string][] }[] } }
    expect(envelope.data.result[0]?.values).toEqual([[1, 'NaN'], [3, '6']])
  })
})

describe('buildRangeRequest（dry-run 与真实请求的同一形状）', () => {
  it('direct 模式：GET /api/v1/query_range 带 step 参数', () => {
    const service = new PrometheusService(new Context(), { endpoint: 'http://prom:9090' })
    const req = service.buildRangeRequest('up', 100, 200, '15s')
    expect(req.url).toBe('http://prom:9090/api/v1/query_range?query=up&start=100.0&end=200.0&step=15s')
    expect(req.body).toBeUndefined()
  })

  it('proxied 模式：POST /api/ds/query + 代理 body——dry-run 不再显示从未发送的直连 URL', () => {
    const service = new PrometheusService(new Context(), { grafanaEndpoint: 'https://grafana.example.com' })
    const req = service.buildRangeRequest('up', 100, 200, '15s')
    expect(req.url).toBe('https://grafana.example.com/api/ds/query')
    const queries = (req.body as { queries: { expr: string; datasource: { uid: string } }[] }).queries
    expect(queries[0]).toMatchObject({ expr: 'up', datasource: { uid: 'prometheus' } })
  })
})
