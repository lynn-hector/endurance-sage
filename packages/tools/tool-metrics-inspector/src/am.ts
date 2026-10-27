/**
 * Parsers for Alertmanager v2 payloads (behind the grafana proxy): camelCase
 * API fields map to the snake_case evidence records the tools emit.
 *
 * @module @dsh-sentry/tool-metrics-inspector/am
 */

import { asRecord } from '@dsh-sentry/metrics-store'

/** One active alert instance (fired; carries no rule expression — that lives in Prometheus rules). */
export interface AmAlertRecord {
  name: string
  status: { state: unknown; inhibited_by: unknown[]; silenced_by: unknown[] }
  labels: Record<string, unknown>
  annotations: Record<string, unknown>
  active_at: unknown
  ends_at: unknown
  fingerprint: unknown
  receivers: string[]
}

/** One silence entry. */
export interface AmSilenceRecord {
  id: string
  status: { state: unknown }
  matchers: { name: unknown; value: unknown; is_regex: boolean }[]
  starts_at: unknown
  ends_at: unknown
  comment: unknown
  created_by: unknown
}

/** Map the v2 alerts array; optional case-insensitive substring filter on `labels.alertname`. */
export function extractAmAlerts(raw: unknown, match?: string): AmAlertRecord[] {
  if (!Array.isArray(raw)) return []
  const needle = match === undefined ? undefined : match.toLowerCase()
  const alerts: AmAlertRecord[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (record === undefined) continue
    const labels = asRecord(record['labels']) ?? {}
    const name = String(labels['alertname'] ?? 'unknown')
    if (needle !== undefined && !name.toLowerCase().includes(needle)) continue
    const status = asRecord(record['status']) ?? {}
    alerts.push({
      name,
      status: {
        state: status['state'] ?? null,
        inhibited_by: Array.isArray(status['inhibitedBy']) ? status['inhibitedBy'] : [],
        silenced_by: Array.isArray(status['silencedBy']) ? status['silencedBy'] : [],
      },
      labels,
      annotations: asRecord(record['annotations']) ?? {},
      active_at: record['startsAt'] ?? null,
      ends_at: record['endsAt'] ?? null,
      fingerprint: record['fingerprint'] ?? null,
      receivers: Array.isArray(record['receivers'])
        ? record['receivers']
          .map((receiver) => asRecord(receiver)?.['name'])
          .filter((name): name is string => typeof name === 'string')
        : [],
    })
  }
  return alerts
}

/** Map the v2 silences array; optional `active`/`expired` state filter. */
export function extractAmSilences(raw: unknown, state?: 'active' | 'expired'): AmSilenceRecord[] {
  if (!Array.isArray(raw)) return []
  const silences: AmSilenceRecord[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (record === undefined) continue
    const status = asRecord(record['status']) ?? {}
    const rawState = String(status['state'] ?? '')
    if (state !== undefined && rawState !== state) continue
    silences.push({
      id: String(record['id'] ?? 'unknown'),
      status: { state: status['state'] ?? null },
      matchers: Array.isArray(record['matchers'])
        ? record['matchers']
          .map((matcher): AmSilenceRecord['matchers'][number] | null => {
            const m = asRecord(matcher)
            if (m === undefined) return null
            return {
              name: m['name'] ?? null,
              value: m['value'] ?? null,
              is_regex: m['isRegex'] === true,
            }
          })
          .filter((matcher): matcher is AmSilenceRecord['matchers'][number] => matcher !== null)
        : [],
      starts_at: record['startsAt'] ?? null,
      ends_at: record['endsAt'] ?? null,
      comment: record['comment'] ?? null,
      created_by: record['createdBy'] ?? null,
    })
  }
  return silences
}
