/**
 * Lightweight log-pattern extraction.
 *
 * Verbatim port of `extract_patterns` from the original
 * `skills/log-analyzer/scripts/fetch_logs.py`: group log rows by the first N
 * characters of `message` (the fingerprint), count occurrences, and track the
 * first/last timestamps. Aggregation only — the agent does the reasoning.
 *
 * @module @dsh-sentry/tool-log-analyzer/patterns
 */

/** One aggregated message fingerprint. */
export interface LogPattern {
  /** The message prefix used as fingerprint. */
  pattern: string
  /** Occurrence count. */
  count: number
  /** Timestamp of the first occurrence. */
  first_at: string
  /** Timestamp of the last occurrence. */
  last_at: string
}

/** Options for {@link extractLogPatterns}. */
export interface ExtractLogPatternsOptions {
  /** How many top patterns to return; defaults to 5. */
  topN?: number
  /** Message prefix length used as fingerprint; defaults to 80. */
  fingerprintLength?: number
  /** Timestamp column read for first/last seen; defaults to `greptime_timestamp`. */
  timestampCol?: string
}

/**
 * Aggregate log rows into top patterns by count. Ties keep first-seen order
 * (both the Python original's `sorted` and this port's `sort` are stable).
 */
export function extractLogPatterns(
  logs: Record<string, unknown>[],
  options: ExtractLogPatternsOptions = {},
): LogPattern[] {
  const topN = options.topN ?? 5
  const fingerprintLength = options.fingerprintLength ?? 80
  const timestampCol = options.timestampCol ?? 'greptime_timestamp'

  const counter = new Map<string, number>()
  const firstSeen = new Map<string, string>()
  const lastSeen = new Map<string, string>()

  for (const log of logs) {
    const message = String(log['message'] ?? '')
    const timestamp = String(log[timestampCol] ?? '')
    const fingerprint = message.slice(0, fingerprintLength)
    counter.set(fingerprint, (counter.get(fingerprint) ?? 0) + 1)
    if (!firstSeen.has(fingerprint)) firstSeen.set(fingerprint, timestamp)
    lastSeen.set(fingerprint, timestamp)
  }

  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topN)
    .map(([fingerprint, count]) => ({
      pattern: fingerprint,
      count,
      first_at: firstSeen.get(fingerprint)!,
      last_at: lastSeen.get(fingerprint)!,
    }))
}
