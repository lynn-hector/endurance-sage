/**
 * Backend-neutral cache inspection Service Definition.
 *
 * A Provider implements this seam and owns the cache platform protocol,
 * connection discovery, authentication and wire decoding. The db index a
 * key lives in is caller intent and stays in the request; endpoints, session
 * cookies and base64 wire fields never cross this seam.
 *
 * @module @dsh-sentry/cache-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

export type { DecodedContent } from './decode.ts'
export { decodeContent } from './decode.ts'

/** Consumer-facing key lookup intent. */
export interface CacheGetRequest {
  /** The cache key, raw string. */
  key: string
  /** Logical db index the key lives in (caller intent, Providers do not default it). */
  db: number
}

/** One decoded cache entry; unknown payload fields pass through as-is. */
export interface CacheEntry {
  /** Echoes the requested key. */
  key: string
  /** Echoes the requested db index. */
  db: number
  /** Identifier of the connection that served the lookup, for evidence. */
  connectionId: string
  /** Backend's display form of the key, when provided. */
  keyDisplay: unknown
  /** Backend's raw key field, when provided. */
  keyRaw: unknown
  /** Remaining TTL in seconds; null when the backend reports none. */
  ttl: unknown
  /** Backend value type label (e.g. string/hash/list). */
  redisType: unknown
  /** Decoded value: parsed JSON object/array, plain text, or null. */
  value: unknown
  /** Encoding label the payload carried (e.g. utf8). */
  valueEncoding: string
  /** Undecoded base64 payload, for raw evidence. */
  valueRawBase64: unknown
  /** Full backend response, for raw evidence. */
  raw: Record<string, unknown>
}

/**
 * Exactly one cache Provider occupies this slot in a Context. Lookups are
 * read-only; session refresh and connection re-discovery are Provider
 * internals triggered on auth failures, never Consumer choreography.
 */
export abstract class CacheStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'cacheStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /** Look up one key and return its decoded entry. */
  abstract getValue(request: CacheGetRequest): Promise<CacheEntry>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cacheStore: CacheStore
  }
}

export default CacheStore
