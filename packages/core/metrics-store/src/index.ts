/**
 * Backend-neutral metrics Service Definition.
 *
 * A Provider implements this seam and owns the PromQL execution transport,
 * datasource routing, endpoint and credentials. PromQL itself is the query
 * intent language and stays in Consumer requests; URLs, datasource uids and
 * auth never cross this seam. The pure envelope parsers live alongside so
 * every implementation returns the same reasoning shape.
 *
 * @module @dsh-sentry/metrics-store
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AlertRecord, AlertRuleRecord, MetricDataPoint } from './parse.ts'

export type { AlertRecord, AlertRuleRecord, MetricDataPoint } from './parse.ts'
export {
  asRecord,
  convertValue,
  extractAlertRules,
  extractDataPoints,
  extractFiringAlerts,
  extractInstantDataPoints,
  formatSampleTimestamp,
  prometheusEnvelopeOrThrow,
} from './parse.ts'

/** Range query intent; timestamps are epoch seconds, `step` a PromQL duration. */
export interface MetricsRangeQuery {
  promql: string
  startSec: number
  endSec: number
  step: string
}

/** Instant query intent: single-point evaluation at `timeSec`. */
export interface MetricsInstantQuery {
  promql: string
  timeSec: number
}

/** Firing-alert listing; the service filter matches the backend's own labels. */
export interface FiringAlertsQuery {
  service?: string
}

/** Rule lookup by case-insensitive name substring, state-agnostic. */
export interface AlertRulesQuery {
  nameContains?: string
}

/** Metric-name discovery over a recent lookback window. */
export interface MetricNamesQuery {
  /** Look-back window in minutes; Providers default to 60. */
  windowMinutes?: number
  /** Server-side cap on returned names; Providers default high. */
  limit?: number
}

/**
 * Exactly one metrics Provider occupies this slot in a Context. All methods
 * are read-only; a non-`success` backend answer surfaces as a thrown Error
 * carrying the backend's own error wording.
 */
export abstract class MetricsStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'metricsStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /**
   * True when the Provider holds enough configuration to serve queries.
   * Consumers use this availability contract for pre-flight error evidence
   * (demo output must not masquerade as real evidence on a half-configured
   * host); it never gates an already-issued query.
   */
  abstract get configured(): boolean

  /** Evaluate one PromQL range query and return the extracted data points. */
  abstract queryRangeMetrics(request: MetricsRangeQuery): Promise<MetricDataPoint[]>

  /** Evaluate one PromQL instant query and return the extracted data points. */
  abstract queryInstantMetrics(request: MetricsInstantQuery): Promise<MetricDataPoint[]>

  /** List currently firing alert instances derived from alerting rules. */
  abstract listFiringAlerts(request: FiringAlertsQuery): Promise<AlertRecord[]>

  /** Look up alerting rule definitions by name substring. */
  abstract listAlertRules(request: AlertRulesQuery): Promise<AlertRuleRecord[]>

  /** List metric names active within the recent window, sorted. */
  abstract listMetricNames(request: MetricNamesQuery): Promise<string[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metricsStore: MetricsStore
  }
}

export default MetricsStore
