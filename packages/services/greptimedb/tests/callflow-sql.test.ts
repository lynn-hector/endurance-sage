import { describe, expect, it } from 'vitest'
import { buildCallFlowSql, escapeSqlLiteral } from '../src/callflow-sql.ts'

/**
 * Golden tests: the query shape mirrors the novo-grafana hep_1 dashboard
 * (`call_id = ? OR trace_id = ?`, ascending by timestamp). If a change here
 * alters any of these strings, it is a behavior change against the
 * documented contract.
 */

const BASE = {
  callId: 'call-1-abc12345@pbx.local',
  start: '2026-06-01T00:00:00Z',
  end: '2026-06-01T23:59:59Z',
  limit: 1000,
  schema: 'public',
  table: 'hep_1',
  timestampCol: 'greptime_timestamp',
} as const

describe('buildCallFlowSql', () => {
  it('dual-key match, time window, ascending order', () => {
    const sql = buildCallFlowSql({ ...BASE })
    expect(sql).toBe(
      `SELECT * FROM "public"."hep_1" `
      + `WHERE ("call_id" = 'call-1-abc12345@pbx.local' OR "trace_id" = 'call-1-abc12345@pbx.local') `
      + `AND "greptime_timestamp" >= '2026-06-01T00:00:00Z' `
      + `AND "greptime_timestamp" <= '2026-06-01T23:59:59Z' `
      + `ORDER BY "greptime_timestamp" ASC `
      + `LIMIT 1000`,
    )
  })

  it('trims the call id and escapes single quotes', () => {
    const sql = buildCallFlowSql({ ...BASE, callId: " o'brien@pbx.local " })
    expect(sql).toContain(`("call_id" = 'o''brien@pbx.local' OR "trace_id" = 'o''brien@pbx.local')`)
  })

  it('escapes quotes in the time bounds too', () => {
    const sql = buildCallFlowSql({ ...BASE, start: "2026-06-01T00:00:00'Z" })
    expect(sql).toContain(`>= '2026-06-01T00:00:00''Z'`)
  })
})

describe('escapeSqlLiteral', () => {
  it('doubles single quotes', () => {
    expect(escapeSqlLiteral("a'b'c")).toBe("a''b''c")
  })
})
