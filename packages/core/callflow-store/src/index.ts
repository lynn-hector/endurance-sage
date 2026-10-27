/**
 * Backend-neutral SIP call-flow query Service Definition.
 *
 * A Provider implements this seam and owns the signaling table, SQL dialect,
 * endpoint and credentials. The pure milestone/error summary lives here so
 * every implementation returns the same reasoning shape.
 *
 * @module @dsh-sentry/callflow-store
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CallSummary } from './summary.ts'

export type { CallMilestones, CallSummary } from './summary.ts'
export { summarizeCallFlow } from './summary.ts'

/** Default lookback when `start` is omitted: signaling triage reaches further back than log triage. */
export const DEFAULT_CALLFLOW_LOOKBACK_MS = 24 * 3600 * 1000

/** Default message cap. */
export const DEFAULT_CALLFLOW_LIMIT = 1000

/** Consumer-facing call-flow intent; SQL and backend identifiers are excluded. */
export interface CallflowQueryRequest {
  /** Call identifier, matched by the Provider against its dual call/trace keys. */
  callId: string
  /** ISO8601 inclusive lower bound; omitted means the Provider's default lookback. */
  start?: string
  /** ISO8601 inclusive upper bound; omitted means now. */
  end?: string
  /** Maximum signaling messages returned. */
  limit?: number
}

/** Normalized query result; the window echoes the values actually applied. */
export interface CallflowQueryResult {
  start: string
  end: string
  limit: number
  messages: Record<string, unknown>[]
  summary: CallSummary
}

/** Exactly one call-flow Provider occupies this slot in a Context. */
export abstract class CallflowStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'callflowStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /** Query one call's signaling messages and their backend-neutral summary. */
  abstract queryCallFlow(request: CallflowQueryRequest): Promise<CallflowQueryResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    callflowStore: CallflowStore
  }
}

export default CallflowStore
