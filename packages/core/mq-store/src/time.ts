/**
 * Time-argument normalization shared by every MqStore Consumer, port of
 * `_parse_time_ms` from `skills/mq-inspector/scripts/inspect.py`: pure-digit
 * millisecond epochs pass through, ISO8601 strings are parsed as UTC, and
 * missing values fall back to a caller-supplied default.
 *
 * @module @dsh-sentry/mq-store
 */

/** Parse a tool time argument into epoch milliseconds. */
export function parseTimeMs(value: string | number | undefined | null, defaultMs?: number): number {
  if (value === undefined || value === null || value === '') {
    return defaultMs ?? Date.now()
  }
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number(text)
  const normalized = text.endsWith('Z') ? text : `${text}Z`
  const dt = new Date(normalized)
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`无法解析时间参数: ${text}`)
  }
  return dt.getTime()
}
