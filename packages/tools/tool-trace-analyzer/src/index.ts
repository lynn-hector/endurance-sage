/**
 * Trace analyzer Tool Consumer.
 *
 * Depends only on the TraceStore Definition and the Session environment
 * Provider router. Backend mode, datasource, endpoint, credentials and
 * transport details belong to the Provider; the Provider for one call is
 * the calling session's bound environment, leased through `envProviders`.
 *
 * @module @dsh-sentry/tool-trace-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import type { TraceStore } from '@dsh-sentry/trace-store'
import type {} from '@dsh-sentry/service-env-provider'

export const name = 'tool-trace-analyzer'
export const inject = ['tools', 'envProviders']

export interface Config {}

export const Config: z<Config> = z.object({})

const SOURCE = 'trace-analyzer'
const TYPE = 'trace'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The store, env label and lease one call fixed at its start. */
interface CallProvider {
  env: string
  store: TraceStore
  release: () => Promise<void>
}

/** Register the trace fetch tool against the backend-neutral seam. */
export function apply(ctx: Context, _config: Config): void {
  // The Provider is the calling session's bound environment: env, backend
  // identity and lease are fixed per call before the first backend await.
  const routeStore = async (exec: ToolRunContext): Promise<CallProvider> => {
    const lease = await ctx.envProviders.forCall(exec)
    return { env: lease.env, store: lease.require('traceStore'), release: lease.release }
  }

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
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeStore(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store } = call
        const backendRef = store.backendRef
        const refs = (): string[] => [backendRef, `env:${env}:traces`]

        const parsed = await store.queryTrace({
          traceId: args.traceId,
          ...args.start !== undefined ? { start: args.start } : {},
          ...args.end !== undefined ? { end: args.end } : {},
          ...args.service !== undefined ? { service: args.service } : {},
          ...args.operation !== undefined ? { operation: args.operation } : {},
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
            env,
            trace_id: args.traceId,
            backend_ref: backendRef,
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
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: call?.env ?? 'unknown',
            trace_id: args.traceId,
            backend_ref: call?.store.backendRef ?? null,
            error: errorMessage(error),
          },
          summary: `查询失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: call?.store.backendRef === undefined
            ? []
            : [call.store.backendRef, `env:${call.env}:traces`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
      }
    },
  }))
}
