/**
 * Call-flow analyzer tool: query the SIP signaling table (`hep_1`) in
 * GreptimeDB by callid and extract the call timeline, returning the unified
 * evidence envelope.
 *
 * In-house port of the call-flow half of the external novo-grafana CLI
 * (grafana-cli.sh pcap / the hep_1 dashboard query): same table, same
 * dual-key match (`call_id = ? OR trace_id = ?`), but native to the dsh
 * assembly — env-matrix credentials, evidence envelope, no local session
 * files. Binary PCAP generation deliberately stays out (Wireshark-grade
 * artifacts are for humans; the agent reasons over the structured flow).
 *
 * @module @dsh-sentry/tool-callflow-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type {} from '@dsh-sentry/service-greptimedb'
import { extractCallSummary } from './summary.ts'
import { buildCallFlowSql } from './sql.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-callflow-analyzer'

/** The seams this plugin registers into. */
export const inject = ['tools', 'greptimedb']

/**
 * Default lookback when `start` is omitted. Signaling triage usually reaches
 * further back than log triage — the caller rarely knows the exact call time.
 */
const DEFAULT_LOOKBACK_MS = 24 * 3600 * 1000
const DEFAULT_LIMIT = 1000

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /**
   * Env label fallback when the assembly files are unreadable; evidence
   * metadata only (same contract as tool-log-analyzer).
   */
  env?: string
  /** GreptimeDB schema of the signaling table. Defaults to `public`. */
  schema?: string
  /** SIP signaling table. Defaults to `hep_1`. */
  table?: string
  /** Timestamp column. Defaults to `greptime_timestamp`. */
  timestampCol?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
  schema: z.string().default('public').description('信令表所在 schema'),
  table: z.string().default('hep_1').description('SIP 信令表名'),
  timestampCol: z.string().default('greptime_timestamp').description('时间范围过滤列'),
})

const SOURCE = 'callflow-analyzer'
const TYPE = 'callflow'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register the call-flow tool. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'
  const schema = config.schema ?? 'public'
  const table = config.table ?? 'hep_1'
  const timestampCol = config.timestampCol ?? 'greptime_timestamp'
  const evidenceRefs = (): string[] => [`env:${liveEnv()}`, `greptimedb:${table}`]

  ctx.tools.register(defineTool({
    name: 'sentry_query_call_flow',
    description:
      'Query the SIP signaling flow (hep_1) from GreptimeDB by callid and extract the call '
      + 'timeline (INVITE/ringing/answer/BYE milestones, PDD, error responses). Read-only. '
      + 'The callid matches both call_id and trace_id. Bridges back to app logs via the '
      + 'returned trace_ids.',
    parameters: {
      callId: {
        type: 'string',
        required: true,
        description: 'Call identifier; matched against both call_id and trace_id.',
      },
      start: {
        type: 'string',
        description: `Range start, ISO8601 (e.g. 2026-06-01T00:00:00Z). Defaults to now-24h.`,
      },
      end: { type: 'string', description: 'Range end, ISO8601. Defaults to now.' },
      limit: {
        type: 'integer',
        default: DEFAULT_LIMIT,
        description: `Max messages returned. Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const callId = args.callId.trim()
      if (callId.length === 0) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: 'callId 不能为空',
          summary: '查询失败: callId 不能为空',
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      }
      // `??` 只挡 nullish：空白串回退默认窗口，否则会生成 `>= ''` 静默查空。
      const start = args.start?.trim() || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
      const end = args.end?.trim() || new Date().toISOString()
      const limit = args.limit ?? DEFAULT_LIMIT

      const sql = buildCallFlowSql({ callId, start, end, limit, schema, table, timestampCol })
      try {
        const messages = await ctx.greptimedb.query(sql)
        const summary = extractCallSummary(messages, { timestampCol })
        const answered = summary.milestones.answer_at !== undefined
        const errorCount = Object.values(summary.error_responses).reduce((acc, count) => acc + count, 0)
        const milestoneText = answered
          ? (summary.pdd_ms !== undefined ? `已接通 PDD ${summary.pdd_ms}ms` : '已接通')
          : '未接通'
        // 双键 OR 匹配可能经 trace_id 带进其他通话，混入时点名让 agent 分通话解读。
        const callIdNote = summary.call_ids.length > 1 ? `，涉及 ${summary.call_ids.length} 个 call_id` : ''
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: liveEnv(), call_id: callId, start, end, sql, messages, summary },
          summary:
            `env=${liveEnv()} call_id=${callId} 时间窗 [${start}, ${end}] `
            + `返回 ${messages.length} 条信令，${milestoneText}，错误响应 ${errorCount} 个${callIdNote}`,
          confidence: messages.length > 0 ? 0.8 : 0.4,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `查询失败: ${errorMessage(error)}`,
          refs: evidenceRefs(),
        }) as unknown as JsonValue
      }
    },
  }))
}
