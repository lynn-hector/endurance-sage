/**
 * Backend-neutral trace query Service Definition.
 *
 * A Provider implements this seam and owns datasource, endpoint, credential
 * and transport configuration. Consumers depend only on ctx.traceStore.
 *
 * @module @dsh-sentry/trace-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** Consumer-facing trace query intent; backend identifiers are excluded. */
export interface TraceQueryRequest {
  traceId: string
  start?: string
  end?: string
  service?: string
  operation?: string
}

export interface TraceTag {
  key?: unknown
  value?: unknown
}

export interface TraceSpan {
  span_id: unknown
  parent_id: unknown
  operation: unknown
  service: unknown
  start_time: unknown
  duration_ms: number
  tags: TraceTag[]
  stack_traces: unknown
  status: 'ok' | 'error'
}

export interface ParsedTrace {
  duration_ms: number
  status: 'ok' | 'error' | 'unknown'
  services: string[]
  spans: TraceSpan[]
  slow_spans: TraceSpan[]
  errors: TraceSpan[]
  frames_count: number
  raw_response?: unknown
}

/** Exactly one trace Provider occupies this slot in a Context. */
export abstract class TraceStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'traceStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /** Fetch and analyze one trace without modifying backend state. */
  abstract queryTrace(request: TraceQueryRequest): Promise<ParsedTrace>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    traceStore: TraceStore
  }
}

export default TraceStore
