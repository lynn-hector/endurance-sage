/**
 * Consumer-side parameter mapping for the metrics tools: short-name
 * templates → PromQL, unit lookup and ISO8601 parsing. The envelope parsers
 * (data points, alert rules) live in `@dsh-sentry/metrics-store` — they are
 * Provider-side shaping shared by every implementation.
 *
 * Pure port of the original metrics-inspector scripts' query construction
 * (`query_metrics.py`: `_METRIC_TEMPLATES`, `_build_promql`,
 * `_parse_iso8601`), keeping its recorded quirks verbatim:
 * - `buildPromql('error_rate')` without a service keeps a literal `%s` in the
 *   output, because the original only stripped the exact `{service="%s"}`
 *   clause and error_rate's clause carries an extra label matcher.
 *
 * @module @dsh-sentry/tool-metrics-inspector/promql
 */

/**
 * Built-in metric templates. Key is the short name accepted in `metrics`;
 * value is `[promql template, unit]`.
 *
 * DEVIATION FROM THE SCRIPT ERA (validated live against the cluster):
 * the original templates used `http_requests_total{service="%s"}` — that
 * metric/label does not exist here. The deployment exposes metrics only
 * through Grafana (datasource uid `prometheus`), series carry the label
 * `app`, HTTP RED metrics follow the Spring naming
 * (`http_server_requests_seconds_*` with `status`/`outcome` labels, present
 * on the Java services), and the Go commctl services expose only
 * `go_*`/`process_*`/business metrics — RED short names may return no
 * matching series for them, which is not equivalent to a numeric zero.
 */
export const METRIC_TEMPLATES: Record<string, readonly [string, string]> = {
  qps: [
    'sum(rate(http_server_requests_seconds_count{app="%s"}[1m]))',
    'req/s',
  ],
  latency_p99: [
    'histogram_quantile(0.99, sum by (le) (rate(http_server_requests_seconds_bucket{app="%s"}[1m])))',
    's',
  ],
  latency_p95: [
    'histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{app="%s"}[1m])))',
    's',
  ],
  error_rate: [
    'sum(rate(http_server_requests_seconds_count{app="%s",status=~"5.."}[1m])) / sum(rate(http_server_requests_seconds_count{app="%s"}[1m]))',
    'ratio',
  ],
  cpu: [
    'rate(process_cpu_seconds_total{app="%s"}[1m])',
    'cores',
  ],
  memory: [
    'process_resident_memory_bytes{app="%s"}',
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
    // No service: strip the exact `{app="%s"}` clause. Note error_rate's
    // clause is `{app="%s",status=~"5.."}` and survives — script-era quirk
    // kept deliberately (see module doc).
    return template[0].replaceAll('{app="%s"}', '')
  }

  let expr = metricName
  if (service && !expr.includes('{') && !expr.includes('}')) {
    expr = `${expr}{app="${service}"}`
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
