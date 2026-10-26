import { describe, expect, it } from 'vitest'
import {
  buildListServicesSql,
  buildLogQuerySql,
  escapeSqlLiteral,
  parseLogFilter,
} from '../src/log-sql.ts'

/**
 * Golden tests: every expected SQL below is quoted verbatim from the original
 * `skills/log-analyzer/SKILL.md`. If a change here alters any of these
 * strings, it is a behavior change against the documented contract.
 */

const BASE = {
  start: '2026-07-27T10:00:00Z',
  end: '2026-07-27T10:30:00Z',
  limit: 1000,
  logType: 'go',
  schema: 'public',
  table: 'k8s_logs',
  timestampCol: 'greptime_timestamp',
} as const

describe('buildLogQuerySql — SKILL.md examples, verbatim', () => {
  it('multi-service query with keyword', () => {
    const sql = buildLogQuerySql({
      ...BASE,
      services: ['commctl-config', 'commctl-call-control', 'media-bridge'],
      keywords: ['ERROR'],
    })
    expect(sql).toBe(
      `SELECT * FROM "public"."k8s_logs" `
      + `WHERE "log_type" = 'go' `
      + `AND "greptime_timestamp" >= '2026-07-27T10:00:00Z' `
      + `AND "greptime_timestamp" <= '2026-07-27T10:30:00Z' `
      + `AND "workload_name" IN ('commctl-config', 'commctl-call-control', 'media-bridge') `
      + `AND ("message" LIKE '%ERROR%') `
      + `ORDER BY "greptime_timestamp" DESC `
      + `LIMIT 1000`,
    )
  })

  it('AND filters plus one OR block', () => {
    const sql = buildLogQuerySql({
      ...BASE,
      services: ['commctl-config'],
      filters: ['tenant=acme', 'trace_id IS NOT NULL'],
      filterOr: ['level=ERROR', 'level=FATAL'],
    })
    // Clause order follows the Python build_sql (base conditions first, then
    // services) — NOT the original SKILL.md "拼接示例", which shows
    // workload_name before the timestamps. That example contradicts both the
    // code and the same document's multi-service example; AND is commutative,
    // so the difference is cosmetic. Recorded as documentation drift to fix
    // in the Phase 4 content migration.
    expect(sql).toBe(
      `SELECT * FROM "public"."k8s_logs" `
      + `WHERE "log_type" = 'go' `
      + `AND "greptime_timestamp" >= '2026-07-27T10:00:00Z' `
      + `AND "greptime_timestamp" <= '2026-07-27T10:30:00Z' `
      + `AND "workload_name" = 'commctl-config' `
      + `AND "tenant" = 'acme' `
      + `AND "trace_id" IS NOT NULL `
      + `AND ("level" = 'ERROR' OR "level" = 'FATAL') `
      + `ORDER BY "greptime_timestamp" DESC `
      + `LIMIT 1000`,
    )
  })

  it('no services adds no workload filter', () => {
    const sql = buildLogQuerySql(BASE)
    expect(sql).toBe(
      `SELECT * FROM "public"."k8s_logs" `
      + `WHERE "log_type" = 'go' `
      + `AND "greptime_timestamp" >= '2026-07-27T10:00:00Z' `
      + `AND "greptime_timestamp" <= '2026-07-27T10:30:00Z' `
      + `ORDER BY "greptime_timestamp" DESC `
      + `LIMIT 1000`,
    )
  })

  it('keywords produce one OR-ed LIKE clause (the --keywords shortcut)', () => {
    const sql = buildLogQuerySql({ ...BASE, keywords: ['TenantAdapter', 'timeout'] })
    expect(sql).toContain(`AND ("message" LIKE '%TenantAdapter%' OR "message" LIKE '%timeout%')`)
    // SKILL.md: --keywords "a,b" is exactly --filter-or "message LIKE %a%" + "message LIKE %b%"
    const viaFilterOr = buildLogQuerySql({
      ...BASE,
      filterOr: ['message LIKE %TenantAdapter%', 'message LIKE %timeout%'],
    })
    expect(sql).toBe(viaFilterOr)
  })
})

describe('buildListServicesSql — SKILL.md example, verbatim', () => {
  it('lists workloads seen in the last 30 minutes', () => {
    const sql = buildListServicesSql({
      logType: 'go',
      schema: 'public',
      table: 'k8s_logs',
      timestampCol: 'greptime_timestamp',
    })
    expect(sql).toBe(
      `SELECT DISTINCT "workload_name" `
      + `FROM "public"."k8s_logs" `
      + `WHERE "workload_name" IS NOT NULL `
      + `AND "greptime_timestamp" >= NOW() - INTERVAL '30 minutes' `
      + `AND "log_type" = 'go' `
      + `ORDER BY "workload_name" `
      + `LIMIT 200`,
    )
  })
})

describe('parseLogFilter', () => {
  it('LIKE keeps user-supplied % wildcards', () => {
    expect(parseLogFilter('not_expand LIKE %50001%')).toBe(`"not_expand" LIKE '%50001%'`)
    expect(parseLogFilter('message NOT LIKE %healthcheck%')).toBe(`"message" NOT LIKE '%healthcheck%'`)
  })

  it('equality and inequality', () => {
    expect(parseLogFilter('tenant=acme')).toBe(`"tenant" = 'acme'`)
    expect(parseLogFilter('level!=INFO')).toBe(`"level" != 'INFO'`)
  })

  it('null checks, case-insensitive operator', () => {
    expect(parseLogFilter('trace_id is null')).toBe(`"trace_id" IS NULL`)
    expect(parseLogFilter('trace_id IS NOT NULL')).toBe(`"trace_id" IS NOT NULL`)
  })

  it('lowercases the field before whitelisting', () => {
    expect(parseLogFilter('Tenant=acme')).toBe(`"tenant" = 'acme'`)
  })

  it('strips one layer of outer quotes from values', () => {
    expect(parseLogFilter('tenant="acme"')).toBe(`"tenant" = 'acme'`)
    expect(parseLogFilter(`tenant='acme'`)).toBe(`"tenant" = 'acme'`)
  })

  it('escapes single quotes in values', () => {
    expect(parseLogFilter(`message LIKE %it's%`)).toBe(`"message" LIKE '%it''s%'`)
  })

  it('rejects unknown fields with the sorted whitelist in the message', () => {
    expect(() => parseLogFilter('password=hunter2')).toThrow(
      `未知字段 'password'，允许字段: ['caller', 'greptime_timestamp', 'level', 'log_type', 'message', 'not_expand', 'tenant', 'trace_id', 'workload_name']`,
    )
  })

  it('rejects empty and unparseable expressions', () => {
    expect(() => parseLogFilter('   ')).toThrow('filter 表达式不能为空')
    expect(() => parseLogFilter('tenant ~ acme')).toThrow(/无法解析 filter 表达式/)
  })
})

describe('escapeSqlLiteral', () => {
  it('doubles single quotes', () => {
    expect(escapeSqlLiteral(`a'b'c`)).toBe(`a''b''c`)
  })
})
