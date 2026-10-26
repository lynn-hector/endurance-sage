/**
 * Call-flow analyzer Tool Consumer.
 *
 * Depends only on the CallflowStore Definition. Signaling SQL, the `hep_1`
 * table, schema/timestamp configuration, endpoint and credentials belong to
 * the Provider. The Provider returns rows plus the backend-neutral summary;
 * this tool keeps the model-facing `sentry_query_call_flow` contract and the
 * evidence envelope.
 *
 * @module @dsh-sentry/tool-callflow-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type {} from '@dsh-sentry/callflow-store'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-callflow-analyzer'

/** The capability slots this plugin registers into. */
export const inject = ['tools', 'callflowStore']

/** Default message cap; the query-window default lives in the Definition. */
const DEFAULT_LIMIT = 1000

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /**
   * Env label fallback when the assembly files are unreadable; evidence
   * metadata only (same contract as tool-log-analyzer).
   */
  env?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
})

const SOURCE = 'callflow-analyzer'
const TYPE = 'callflow'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register the call-flow tool against the backend-neutral seam. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

  ctx.tools.register(defineTool({
    name: 'sentry_query_call_flow',
    description:
      'Query the SIP signaling flow by callid and extract the call timeline '
      + '(INVITE/ringing/answer/BYE milestones, PDD, error responses). Read-only. '
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
        description: 'Range start, ISO8601 (e.g. 2026-06-01T00:00:00Z). Defaults to now-24h.',
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
      const store = ctx.callflowStore
      const backendRef = store.backendRef
      const refs = (): string[] => [backendRef, `env:${liveEnv()}:callflow`]
      const callId = args.callId.trim()

      if (callId.length === 0) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: 'callId 不能为空',
          summary: '查询失败: callId 不能为空',
          refs: refs(),
        }) as unknown as JsonValue
      }

      try {
        const result = await store.queryCallFlow({
          callId,
          ...args.start !== undefined ? { start: args.start } : {},
          ...args.end !== undefined ? { end: args.end } : {},
          ...args.limit !== undefined ? { limit: args.limit } : {},
        })
        const { summary, messages } = result
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
          data: {
            env: liveEnv(),
            backend_ref: backendRef,
            call_id: callId,
            start: result.start,
            end: result.end,
            limit: result.limit,
            messages,
            summary,
          },
          summary:
            `env=${liveEnv()} call_id=${callId} 时间窗 [${result.start}, ${result.end}] `
            + `返回 ${messages.length} 条信令，${milestoneText}，错误响应 ${errorCount} 个${callIdNote}`,
          confidence: messages.length > 0 ? 0.8 : 0.4,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `查询失败: ${errorMessage(error)}`,
          refs: refs(),
        }) as unknown as JsonValue
      }
    },
  }))
}
