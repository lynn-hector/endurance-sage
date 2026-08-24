import { describe, expect, it } from 'vitest'
import { framesToQueryRangeEnvelope } from '../src/index.ts'

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
