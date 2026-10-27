/**
 * Backend-neutral log query Service Definition.
 *
 * A Provider implements this seam and owns the log table, SQL dialect,
 * endpoint, credentials and field whitelist. Consumers depend only on
 * ctx.logStore and express query intent, never backend configuration.
 *
 * @module @dsh-sentry/log-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** One returned log row, keyed by backend column name. */
export type LogRecord = Record<string, unknown>

/** Consumer-facing log query intent; SQL and backend identifiers are excluded. */
export interface LogQueryRequest {
  /** Workload names to restrict the query to; omitted means all workloads. */
  services?: string[]
  /** ISO8601 inclusive lower bound. */
  start: string
  /** ISO8601 inclusive upper bound. */
  end: string
  /** Substrings OR-matched against the log message. */
  keywords?: string[]
  /** AND-connected filter DSL expressions. */
  filters?: string[]
  /** Filter DSL expressions OR-ed as one block, AND-ed with the rest. */
  filterOr?: string[]
  /** Maximum rows returned. */
  limit?: number
  /** Log type label, e.g. `go`, `nginx` or `java`. */
  logType?: string
}

/** Request for recent workload discovery. */
export interface ListLogServicesRequest {
  /** Log type label; Providers default to `go`. */
  logType?: string
}

/** Query result plus the field pure log-pattern extraction should read. */
export interface LogQueryResult {
  records: LogRecord[]
  timestampField: string
}

/**
 * Filter-DSL field whitelist of the standard `k8s_logs` schema every matrix
 * environment renders (same schema/table in `renderEntries`). The Provider
 * still owns runtime validation via `logFilterFields`; Consumers need the
 * list at registration time to describe the DSL before any Provider is
 * leased, so the shared schema contract lives here as the single source.
 */
export const K8S_LOG_FILTER_FIELDS = [
  'greptime_timestamp',
  'log_type',
  'workload_name',
  'message',
  'not_expand',
  'trace_id',
  'tenant',
  'caller',
  'level',
] as const

/** Exactly one log Provider occupies this slot in a Context. */

export abstract class LogStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'logStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /**
   * Field names accepted by the filter DSL. The Provider owns the whitelist;
   * Consumers use this read-only list to describe the DSL to the model.
   */
  abstract get logFilterFields(): readonly string[]

  /** Query read-only log rows without modifying backend state. */
  abstract queryLogs(request: LogQueryRequest): Promise<LogQueryResult>

  /** List workload names that recently produced logs. */
  abstract listLogServices(request: ListLogServicesRequest): Promise<string[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    logStore: LogStore
  }
}

export default LogStore
