/**
 * Pure port of the original metrics-inspector scripts' query-construction and
 * response-parsing helpers:
 * - `query_metrics.py`: `_METRIC_TEMPLATES`, `_build_promql`,
 *   `_parse_iso8601`, `_convert_value`, `_extract_data_points`;
 * - `list_alerts.py`: `_extract_firing_alerts`.
 *
 * Everything here is verbatim behavior, including two recorded quirks of the
 * original implementation:
 * - `buildPromql('error_rate')` without a service keeps a literal `%s` in the
 *   output, because the original only stripped the exact `{service="%s"}`
 *   clause and error_rate's clause carries an extra label matcher;
 * - `extractFiringAlerts` hardcodes `state === 'firing'` — the original
 *   script parsed a `--state` CLI flag and never used it.
 *
 * @module @dsh-sentry/tool-metrics-inspector/promql
 */

/**
 * Built-in metric templates. Key is the short name accepted in `metrics`;
 * value is `[promql template, unit]`, matching the original
 * `_METRIC_TEMPLATES` table row for row.
 */
export const METRIC_TEMPLATES: Record<string, readonly [string, string]> = {
  qps: [
    'rate(http_requests_total{service="%s"}[1m])',
    'req/s',
  ],
  latency_p99: [
    'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{service="%s"}[1m]))',
    's',
  ],
  latency_p95: [
    'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{service="%s"}[1m]))',
    's',
  ],
  error_rate: [
    'rate(http_requests_total{service="%s",status=~"5.."}[1m]) / rate(http_requests_total{service="%s"}[1m])',
    'ratio',
  ],
  cpu: [
    'rate(process_cpu_seconds_total{service="%s"}[1m])',
    'ratio',
  ],
  memory: [
    'process_resident_memory_bytes{service="%s"}',
    'bytes',
  ],
}

/** Unit for a short metric name; `unknown` for custom PromQL, as in the original. */
export function metricUnit(name: string): string {
  return METRIC_TEMPLATES[name]?.[1] ?? 'unknown'
}

/**
 * Original `_build_promql`: expand a short name through its template, or pass
 * custom PromQL through (appending a `{service="..."}` filter only when the
 * expression contains no braces).
 */
export function buildPromql(metricName: string, service?: string): string {
  const template = METRIC_TEMPLATES[metricName]
  if (template !== undefined) {
    if (service) return template[0].replaceAll('%s', service)
    // No service: strip the exact `{service="%s"}` clause. Note error_rate's
    // clause is `{service="%s",status=~"5.."}` and survives — original quirk,
    // kept deliberately (see module doc).
    return template[0].replaceAll('{service="%s"}', '')
  }

  let expr = metricName
  if (service && !expr.includes('{') && !expr.includes('}')) {
    expr = `${expr}{service="${service}"}`
  }
  return expr
}

/**
 * Original `_parse_iso8601`: parse an ISO8601 string into UTC second
 * timestamps. Naive input (no timezone designator) is treated as UTC — note
 * `Date.parse` alone would treat it as local time, so a `Z` is pinned on.
 *
 * @throws Error with CPython 3.11+ `datetime.fromisoformat` wording
 *   (`Invalid isoformat string: '<value>'`) on unparseable input.
 */
export function parseIso8601(value: string): number {
  let normalized = value
  if (!/[zZ]$/.test(normalized) && !/[+-]\d{2}:?\d{2}(:\d{2})?$/.test(normalized)) {
    normalized = `${normalized}Z`
  }
  const ms = Date.parse(normalized)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid isoformat string: '${value}'`)
  }
  return ms / 1000
}

/**
 * Original `_convert_value`: coerce a Prometheus sample value to a finite
 * number; NaN/Inf/unparseable input becomes `null` (the sample is dropped).
 */
export function convertValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  // Python `float('')` raises ValueError; `Number('')` would yield 0.
  if (typeof raw === 'string' && raw.trim() === '') return null
  const value = Number(raw)
  if (Number.isNaN(value) || !Number.isFinite(value)) return null
  return value
}

/** One extracted data point, the original `_extract_data_points` element. */
export interface MetricDataPoint {
  /** ISO8601 UTC, second precision, `Z` suffix. */
  timestamp: string
  value: number
  labels: Record<string, unknown>
}

/**
 * Format a sample timestamp like the original:
 * `datetime.fromtimestamp(ts, utc).replace(microsecond=0).isoformat()` with
 * the `+00:00` suffix swapped for `Z`.
 */
export function formatSampleTimestamp(ts: number): string {
  return new Date(Math.trunc(ts) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Original `_extract_data_points`: only `resultType === "matrix"` responses
 * yield points; samples whose value converts to `null` (NaN/Inf/garbage) are
 * dropped; labels come from the series' `metric` object.
 */
export function extractDataPoints(raw: unknown): MetricDataPoint[] {
  const points: MetricDataPoint[] = []
  const data = asRecord(asRecord(raw)?.['data'])
  if (data === undefined || data['resultType'] !== 'matrix') return points

  const result = data['result']
  if (!Array.isArray(result)) return points
  for (const series of result) {
    const seriesRecord = asRecord(series)
    if (seriesRecord === undefined) continue
    const labels = asRecord(seriesRecord['metric']) ?? {}
    const values = seriesRecord['values']
    if (!Array.isArray(values)) continue
    for (const pair of values) {
      if (!Array.isArray(pair) || pair.length < 2) continue
      const converted = convertValue(pair[1])
      if (converted === null) continue
      points.push({
        timestamp: formatSampleTimestamp(Number(pair[0])),
        value: converted,
        labels,
      })
    }
  }
  return points
}

/** One firing alert, the original `_extract_firing_alerts` element. */
export interface AlertRecord {
  name: string
  state: string
  severity: string
  started_at: unknown
  labels: Record<string, unknown>
  annotations: Record<string, unknown>
  value: unknown
}

/**
 * Original `_extract_firing_alerts`: throw when the response status is not
 * `success`; walk rule groups keeping only `type === "alerting"` rules in
 * hardcoded `firing` state (the original's `--state` flag was never wired
 * up); optionally filter alerts by their `service` label.
 */
export function extractFiringAlerts(raw: unknown, service?: string): AlertRecord[] {
  const rawRecord = asRecord(raw)
  if (rawRecord?.['status'] !== 'success') {
    const error = rawRecord?.['error']
    throw new Error(error === undefined ? 'unknown error' : String(error))
  }

  const alerts: AlertRecord[] = []
  const groups = asRecord(rawRecord['data'])?.['groups']
  if (!Array.isArray(groups)) return alerts
  for (const group of groups) {
    const rules = asRecord(group)?.['rules']
    if (!Array.isArray(rules)) continue
    for (const rule of rules) {
      const ruleRecord = asRecord(rule)
      if (ruleRecord === undefined || ruleRecord['type'] !== 'alerting') continue
      const state = (ruleRecord['state'] ?? 'inactive') as string
      if (state !== 'firing') continue
      const name = (ruleRecord['name'] ?? 'unknown') as string
      const ruleAlerts = ruleRecord['alerts']
      if (!Array.isArray(ruleAlerts)) continue
      for (const alert of ruleAlerts) {
        const alertRecord = asRecord(alert)
        if (alertRecord === undefined) continue
        const labels = asRecord(alertRecord['labels']) ?? {}
        if (service && labels['service'] !== service) continue
        alerts.push({
          name,
          state,
          severity: (labels['severity'] ?? 'unknown') as string,
          started_at: alertRecord['activeAt'] ?? 'unknown',
          labels,
          annotations: asRecord(alertRecord['annotations']) ?? {},
          value: alertRecord['value'] ?? null,
        })
      }
    }
  }
  return alerts
}
