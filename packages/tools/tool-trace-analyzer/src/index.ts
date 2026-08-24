/**
 * Trace analyzer tool: fetch one distributed trace by id and return the
 * parsed analysis (spans, slow spans, errors) in the unified evidence
 * envelope.
 *
 * Port of the original `skills/trace-analyzer` (SKILL.md + fetch_traces.py).
 * The CLI flags collapse into one JSON-Schema tool; the environment
 * descriptors (`datasource_uid` / `datasource_id`) moved into this plugin's
 * `Config`, and `--env` became the `env` evidence label.
 *
 * Deliberate normalization: the Python `_build_evidence` returned the
 * evidence fields bare, without the `{ evidence: ... }` envelope the
 * project's own `templates/evidence-format.md` mandates (recorded drift).
 * This tool emits the standard envelope via `@dsh-sentry/evidence`.
 *
 * @module @dsh-sentry/tool-trace-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import type {} from '@dsh-sentry/service-trace'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-trace-analyzer'

/** The seams this plugin registers into. */
export const inject = ['tools', 'trace']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Environment label (`local` / `staging` / `production`); evidence metadata only. */
  env: string
  /** Grafana Jaeger datasource uid (grafana-jaeger mode). */
  datasourceUid?: string
  /** Grafana numeric datasource id (grafana-jaeger mode; from the original config, e.g. 6). */
  datasourceId?: number
}

export const Config: z<Config> = z.object({
  env: z.string().required().description('环境标识（local/staging/production），仅作为 evidence 元数据'),
  datasourceUid: z.string().description('Grafana Jaeger 数据源 uid（grafana-jaeger 模式必填）'),
  datasourceId: z.number().step(1).description('Grafana 数据源数字 id（可选，原 config 为 6）'),
})

const SOURCE = 'trace-analyzer'
const TYPE = 'trace'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register the trace fetch tool. */
export function apply(ctx: Context, config: Config): void {
  const refs = [
    `grafana:${config.datasourceUid ?? 'jaeger'}`,
    `env:${config.env}:traces`,
  ]

  ctx.tools.register(defineTool({
    name: 'sentry_fetch_trace',
    description:
      'Fetch one distributed trace by traceId and analyze its spans: total duration, involved services, '
      + 'slow spans (>100ms), and error spans. traceId usually comes from a log entry (the trace_id field). '
      + 'Read-only.',
    parameters: {
      traceId: { type: 'string', required: true, description: 'The trace id, aligned with the trace_id field in logs.' },
      start: { type: 'string', description: 'Range start: ISO8601 or relative like now-1h/now-30m/now-1d. Defaults to now-1h.' },
      end: { type: 'string', description: 'Range end: ISO8601 or now. Defaults to now.' },
      service: { type: 'string', description: 'Search mode: service name (reserved pass-through).' },
      operation: { type: 'string', description: 'Search mode: operation name (reserved pass-through).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      try {
        const parsed = await ctx.trace.queryTrace({
          traceId: args.traceId,
          ...args.start !== undefined ? { start: args.start } : {},
          ...args.end !== undefined ? { end: args.end } : {},
          ...args.service !== undefined ? { service: args.service } : {},
          ...args.operation !== undefined ? { operation: args.operation } : {},
          ...config.datasourceUid !== undefined ? { datasourceUid: config.datasourceUid } : {},
          ...config.datasourceId !== undefined ? { datasourceId: config.datasourceId } : {},
        })

        const summaryParts = [`trace ${args.traceId} 查询完成`]
        if (parsed.duration_ms) summaryParts.push(`总耗时 ${parsed.duration_ms}ms`)
        if (parsed.services.length > 0) summaryParts.push(`涉及服务 ${parsed.services.join(', ')}`)
        if (parsed.slow_spans.length > 0) summaryParts.push(`慢调用 ${parsed.slow_spans.length} 个`)
        if (parsed.errors.length > 0) summaryParts.push(`错误 span ${parsed.errors.length} 个`)

        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: config.env,
            trace_id: args.traceId,
            endpoint: ctx.trace.endpoint,
            datasource_uid: config.datasourceUid ?? '',
            frames_count: parsed.frames_count,
            duration_ms: parsed.duration_ms,
            status: parsed.status,
            services: parsed.services,
            spans: parsed.spans,
            slow_spans: parsed.slow_spans,
            errors: parsed.errors,
            ...parsed.raw_response !== undefined ? { raw_response: parsed.raw_response } : {},
          },
          summary: summaryParts.join('，'),
          confidence: parsed.spans.length > 0 ? 0.9 : 0.5,
          refs,
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: config.env,
            trace_id: args.traceId,
            error: errorMessage(error),
          },
          summary: `查询失败: ${errorMessage(error)}`,
          confidence: 0,
          refs,
        }) as unknown as JsonValue
      }
    },
  }))
}
