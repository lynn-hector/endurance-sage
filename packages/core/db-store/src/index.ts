/**
 * Backend-neutral SQL query Service Definition.
 *
 * A Provider implements this seam and owns connection discovery, platform
 * requests, authentication and refresh choreography. SQL is the query intent
 * language and stays in Consumer requests; endpoints, session cookies and
 * connection-picking vocabulary never cross this seam. The database a query
 * runs against is caller intent (the model picks it) and stays in the
 * request.
 *
 * @module @dsh-sentry/db-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

/**
 * Consumer-facing query intent. `database` is the caller's logical choice,
 * not Provider configuration; Providers execute read-only SQL within it.
 */
export interface DbQueryRequest {
  /** The SQL statement to execute (read-only). */
  sql: string
  /** Database name the statement runs against. */
  database: string
  /** Maximum rows returned. Providers default to 100. */
  maxRows?: number
}

/** Query result; `results` is the backend's result-set list, first set is the primary answer. */
export interface DbQueryResult {
  /** The database actually used (echoes the request). */
  database: string
  /** Identifier of the connection that served the query, for evidence. */
  connectionId: string
  /** Raw result sets; Consumers surface the first and keep the rest as raw evidence. */
  results: Record<string, unknown>[]
}

/**
 * Exactly one SQL Provider occupies this slot in a Context. Implementations
 * are read-only; session refresh and connection re-discovery are Provider
 * internals triggered on auth failures, never Consumer choreography.
 */
export abstract class DbStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'dbStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /** Execute one read-only SQL statement and return its result sets. */
  abstract querySql(request: DbQueryRequest): Promise<DbQueryResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dbStore: DbStore
  }
}

export default DbStore
