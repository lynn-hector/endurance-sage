/**
 * Pure parsers for the Prometheus-shaped envelopes a MetricsStore Provider
 * returns: query_range / query data points and /api/v1/rules alert entries.
 * They live in the Definition so every implementation maps raw backends onto
 * the same reasoning shape.
 *
 * Verbatim port of the original metrics-inspector scripts' parsing helpers
 * (`query_metrics.py`: `_convert_value`, `_extract_data_points`;
 * `list_alerts.py`: `_extract_firing_alerts`), including two recorded quirks:
 * - `extractFiringAlerts` hardcodes `state === 'firing'` — the original
 *   script parsed a `--state` CLI flag and never used it;
 * - samples whose value is NaN/Inf/unparseable are dropped, not zeroed.
 *
 * @module @dsh-sentry/metrics-store/parse
 */

/** Narrow unknown payloads to plain records; arrays and null are not records. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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

/**
 * Envelope guard shared by every Prometheus-shaped read: a non-`success`
 * status throws with the backend's `error` field, `unknown error` when the
 * field is missing — the exact wording the original tool loop produced.
 */
export function prometheusEnvelopeOrThrow(raw: unknown): Record<string, unknown> | undefined {
  const rawRecord = asRecord(raw)
  if (rawRecord?.['status'] !== 'success') {
    const errorValue = rawRecord?.['error']
    throw new Error(errorValue === undefined ? 'unknown error' : String(errorValue))
  }
  return rawRecord
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

/**
 * Instant counterpart of `extractDataPoints`: a `vector` response yields one
 * data point per series (`value: [ts, raw]`), with the same NaN/Inf drop and
 * label handling as the range extractor.
 */
export function extractInstantDataPoints(raw: unknown): MetricDataPoint[] {
  const points: MetricDataPoint[] = []
  const data = asRecord(asRecord(raw)?.['data'])
  if (data === undefined || data['resultType'] !== 'vector') return points
  const result = data['result']
  if (!Array.isArray(result)) return points
  for (const series of result) {
    const seriesRecord = asRecord(series)
    if (seriesRecord === undefined) continue
    const labels = asRecord(seriesRecord['metric']) ?? {}
    const value = seriesRecord['value']
    if (!Array.isArray(value) || value.length < 2) continue
    const converted = convertValue(value[1])
    if (converted === null) continue
    points.push({ timestamp: formatSampleTimestamp(Number(value[0])), value: converted, labels })
  }
  return points
}

/** One firing alert, the original `_extract_firing_alerts` element. */
export interface AlertRecord {
  name: string
  state: string
  severity: string
  /** 规则的 PromQL 表达式（rules[].query）；缺失为 null。 */
  query: string | null
  /** 规则的 for 时长（秒，rules[].duration 数字化）；缺失或非有限值为 null。 */
  duration: number | null
  started_at: unknown
  labels: Record<string, unknown>
  annotations: Record<string, unknown>
  value: unknown
}

/**
 * Rule `for` duration in seconds. JSON `null` / missing / blank are null —
 * NOT 0 (`Number(null)` and `Number('')` are both finite 0, which would
 * report a real "for 0s" fact that the rule never stated). Numeric strings
 * keep converting, matching the original extractor's tolerance.
 */
function parseRuleDuration(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** One normalized alerting rule emitted by {@link walkAlertingRules}. */
interface NormalizedRule {
  name: string
  group: string
  query: string | null
  duration: number | null
  labels: Record<string, unknown>
  annotations: Record<string, unknown>
  state: string
  alerts: { active_at: unknown; value: unknown; labels: Record<string, unknown>; annotations: Record<string, unknown> }[]
}

/**
 * Shared walker for the Prometheus `/api/v1/rules` envelope: throws when
 * status is not `success`, then yields every `type === "alerting"` rule with
 * name/query/duration/state normalized. The two public extractors differ
 * only in policy (firing-state + service filter vs name filter + full
 * state) — the envelope handling lives here exactly once.
 */
function* walkAlertingRules(raw: unknown): Generator<NormalizedRule> {
  const rawRecord = prometheusEnvelopeOrThrow(raw)
  const groups = asRecord(rawRecord?.['data'])?.['groups']
  if (!Array.isArray(groups)) return
  for (const group of groups) {
    const groupRecord = asRecord(group)
    if (groupRecord === undefined) continue
    const groupName = String(groupRecord['name'] ?? 'unknown')
    const groupRules = groupRecord['rules']
    if (!Array.isArray(groupRules)) continue
    for (const rule of groupRules) {
      const ruleRecord = asRecord(rule)
      if (ruleRecord === undefined || ruleRecord['type'] !== 'alerting') continue
      const alerts: NormalizedRule['alerts'] = []
      const ruleAlerts = ruleRecord['alerts']
      if (Array.isArray(ruleAlerts)) {
        for (const alert of ruleAlerts) {
          const alertRecord = asRecord(alert)
          if (alertRecord === undefined) continue
          alerts.push({
            active_at: alertRecord['activeAt'] ?? 'unknown',
            value: alertRecord['value'] ?? null,
            labels: asRecord(alertRecord['labels']) ?? {},
            annotations: asRecord(alertRecord['annotations']) ?? {},
          })
        }
      }
      yield {
        name: String(ruleRecord['name'] ?? 'unknown'),
        group: groupName,
        query: typeof ruleRecord['query'] === 'string' ? ruleRecord['query'] : null,
        duration: parseRuleDuration(ruleRecord['duration']),
        labels: asRecord(ruleRecord['labels']) ?? {},
        annotations: asRecord(ruleRecord['annotations']) ?? {},
        state: String(ruleRecord['state'] ?? 'inactive'),
        alerts,
      }
    }
  }
}

/**
 * Original `_extract_firing_alerts`: walk rule groups keeping only
 * `type === "alerting"` rules in hardcoded `firing` state (the original's
 * `--state` flag was never wired up); optionally filter alerts by their
 * `service` label.
 */
export function extractFiringAlerts(raw: unknown, service?: string): AlertRecord[] {
  const alerts: AlertRecord[] = []
  for (const rule of walkAlertingRules(raw)) {
    if (rule.state !== 'firing') continue
    for (const alert of rule.alerts) {
      if (service && alert.labels['service'] !== service && alert.labels['app'] !== service) continue
      alerts.push({
        name: rule.name,
        state: rule.state,
        severity: (alert.labels['severity'] ?? 'unknown') as string,
        query: rule.query,
        duration: rule.duration,
        started_at: alert.active_at,
        labels: alert.labels,
        annotations: alert.annotations,
        value: alert.value,
      })
    }
  }
  return alerts
}

/** One alert-rule definition from Prometheus `/api/v1/rules` (state-agnostic). */
export interface AlertRuleRecord {
  name: string
  group: string
  query: string | null
  duration: number | null
  labels: Record<string, unknown>
  annotations: Record<string, unknown>
  state: string
  firing: { active_at: unknown; value: unknown; labels: Record<string, unknown> }[]
}

/**
 * Look up alerting rules by name substring (case-insensitive). Unlike
 * `extractFiringAlerts` this walks every rule regardless of state —
 * analyzing a historical alert means the rule may be inactive by now — and
 * keeps the group, expression and for-duration so the caller can rebuild
 * the query the alert fired on.
 */
export function extractAlertRules(raw: unknown, nameFilter?: string): AlertRuleRecord[] {
  const needle = nameFilter === undefined ? undefined : nameFilter.toLowerCase()
  const rules: AlertRuleRecord[] = []
  for (const rule of walkAlertingRules(raw)) {
    if (needle !== undefined && !rule.name.toLowerCase().includes(needle)) continue
    rules.push({
      name: rule.name,
      group: rule.group,
      query: rule.query,
      duration: rule.duration,
      labels: rule.labels,
      annotations: rule.annotations,
      state: rule.state,
      firing: rule.alerts.map(alert => ({ active_at: alert.active_at, value: alert.value, labels: alert.labels })),
    })
  }
  return rules
}
