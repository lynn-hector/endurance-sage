/**
 * Metrics inspector tools: query Prometheus metrics and list firing alerts,
 * returning the unified evidence envelope.
 *
 * Port of the original `skills/metrics-inspector` (SKILL.md +
 * `scripts/query_metrics.py` + `scripts/list_alerts.py`). The CLI flags
 * collapse into two JSON-Schema tools:
 * - `sentry_query_metrics` — `--start/--end/--metrics/--service/--step/--dry-run/--demo`;
 * - `sentry_list_alerts` — `--service/--state/--demo`.
 *
 * `--metrics` (a comma-separated string) became a string array; `--env`
 * became the `env` label in `Config` — the environment is an assembly-time
 * choice now, and the label survives only as evidence metadata. The original
 * `config/{env}.yml:metrics` evidence refs became `env:<env>`; the endpoint
 * ref is kept.
 *
 * Recorded behavior notes (faithful ports, not fixes — see `promql.ts`):
 * - `sentry_list_alerts` accepts `state` but still returns firing alerts
 *   only, exactly like the original script, which parsed `--state` and never
 *   used it;
 * - the built-in `error_rate` template keeps a literal `%s` when no service
 *   is given.
 *
 * Deliberate deviations from the scripts:
 * - dry-run returns one evidence envelope carrying every metric's request;
 *   the original printed raw (non-evidence) JSON for the FIRST metric only
 *   and exited mid-loop;
 * - evidence refs use the `env:<env>` style instead of the removed
 *   `config/{env}.yml` path (the missing-endpoint error messages keep their
 *   original wording verbatim, path included);
 * - transport failure wording is unified in the service layer
 *   (`请求 Prometheus 失败: ...`).
 *
 * @module @dsh-sentry/tool-metrics-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError, nowIso } from '@dsh-sentry/evidence'
import type {} from '@dsh-sentry/service-prometheus'
import {
  buildPromql,
  extractDataPoints,
  extractFiringAlerts,
  metricUnit,
  parseIso8601,
} from './promql.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-metrics-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'prometheus']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /**
   * Environment label (`local` / `staging` / `production`). Assembly-time
   * metadata only: it lands in evidence summaries and never switches anything
   * at runtime — the loaded datasource config already is one environment.
   */
  env: string
}

export const Config: z<Config> = z.object({
  env: z.string().required().description('环境标识（local/staging/production），仅作为 evidence 元数据'),
})

const SOURCE = 'metrics-inspector'
const TYPE_METRIC = 'metric'
const TYPE_ALERT = 'alert'
const DEFAULT_METRICS = ['qps', 'latency_p99', 'error_rate']
const DEFAULT_STEP = '15s'
const QUERY_RANGE_PATH = '/api/v1/query_range'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Register the two metrics-inspector tools. */
export function apply(ctx: Context, config: Config): void {
  const envRef = `env:${config.env}`

  /** Evidence refs in the original's two-element shape: datasource ref + endpoint. */
  const refs = (): string[] => {
    const endpoint = ctx.prometheus.endpoint
    return endpoint.length > 0 ? [envRef, endpoint] : [envRef]
  }

  /** Original endpoint guard, shared by both scripts, original wording kept. */
  const missingEndpointError = (type: string): JsonValue =>
    buildEvidenceError({
      source: SOURCE,
      type,
      error: `config/${config.env}.yml 中 datasources.metrics.endpoint 未配置`,
      summary: `缺少 metrics 数据源配置：config/${config.env}.yml:metrics.endpoint`,
      refs: [envRef],
    }) as unknown as JsonValue

  ctx.tools.register(defineTool({
    name: 'sentry_query_metrics',
    description:
      'Query Prometheus metrics over a time range and return one evidence envelope per call. '
      + 'Read-only. `metrics` accepts built-in short names '
      + '(qps / latency_p99 / latency_p95 / error_rate / cpu / memory) or raw PromQL expressions; '
      + 'at least qps, latency_p99 and error_rate should be queried together when triaging. '
      + 'Prefer a tight time window (5–30 minutes around the symptom).',
    parameters: {
      start: { type: 'string', required: true, description: 'Range start, ISO8601 (e.g. 2026-07-22T10:00:00Z).' },
      end: { type: 'string', required: true, description: 'Range end, ISO8601.' },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        default: [...DEFAULT_METRICS],
        description: `Metric short names or raw PromQL expressions. Defaults to ${DEFAULT_METRICS.join(',')}.`,
      },
      service: { type: 'string', description: 'Service name, used for the {service="..."} label filter.' },
      step: { type: 'string', default: DEFAULT_STEP, description: `Query resolution step. Defaults to ${DEFAULT_STEP}.` },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed requests, do not send.' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Prometheus.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const service = args.service
      const serviceLabel = service || 'all'

      // Original ordering: endpoint check first, then demo, then time parsing.
      if (ctx.prometheus.endpoint.length === 0) return missingEndpointError(TYPE_METRIC)

      if (args.demo === true) {
        // The original demo path used the raw (untrimmed) --metrics split.
        const metricNames = args.metrics ?? DEFAULT_METRICS
        const svc = service || 'all-services'
        const metricResults = metricNames.map(metricName => ({
          name: metricName,
          promql: buildPromql(metricName, service),
          unit: metricUnit(metricName),
          data_points: [
            {
              timestamp: args.start,
              value: metricName === 'latency_p99' ? 120.0 : 0.05,
              labels: { service: svc },
            },
            {
              timestamp: args.end,
              value: metricName === 'latency_p99' ? 3200.0 : 0.35,
              labels: { service: svc },
            },
          ],
        }))
        return buildEvidence({
          source: SOURCE,
          type: TYPE_METRIC,
          data: {
            env: config.env,
            service: service ?? null,
            start: args.start,
            end: args.end,
            demo: true,
            metrics: metricResults,
          },
          summary: `[demo] env=${config.env} service=${svc} 查询 ${metricNames.length} 个指标，返回演示数据。`,
          confidence: 1.0,
          refs: [envRef],
        }) as unknown as JsonValue
      }

      let startTs: number
      let endTs: number
      try {
        startTs = parseIso8601(args.start)
        endTs = parseIso8601(args.end)
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE_METRIC,
          error: `时间格式错误: ${errorMessage(error)}`,
          summary: '--start 或 --end 不是合法的 ISO8601 时间',
          refs: [envRef],
        }) as unknown as JsonValue
      }

      const step = args.step ?? DEFAULT_STEP
      const metricNames = (args.metrics ?? DEFAULT_METRICS)
        .map(metricName => metricName.trim())
        .filter(metricName => metricName.length > 0)

      if (args.dryRun === true) {
        // Deviation (see module doc): one envelope with every metric's
        // request; the original printed only the first and exited. The
        // Authorization header is omitted exactly like the original dry-run.
        const requests = metricNames.map(metricName => ({
          url: `${ctx.prometheus.endpoint}${QUERY_RANGE_PATH}`,
          query: buildPromql(metricName, service),
          start: startTs,
          end: endTs,
          step,
          headers: { accept: 'application/json' },
        }))
        return buildEvidence({
          source: SOURCE,
          type: TYPE_METRIC,
          data: {
            env: config.env,
            service: service ?? null,
            start: args.start,
            end: args.end,
            step,
            dry_run: true,
            requests,
          },
          summary: `[dry-run] env=${config.env} service=${serviceLabel} 构造 ${metricNames.length} 个查询请求，未发送。`,
          confidence: 1.0,
          refs: refs(),
        }) as unknown as JsonValue
      }

      const metricResults: Record<string, unknown>[] = []
      const errors: string[] = []
      for (const metricName of metricNames) {
        const promql = buildPromql(metricName, service)
        const unit = metricUnit(metricName)
        try {
          const raw = await ctx.prometheus.queryRange(promql, startTs, endTs, step)
          const rawRecord = asRecord(raw)
          if (rawRecord?.['status'] !== 'success') {
            const errorValue = rawRecord?.['error']
            throw new Error(errorValue === undefined ? 'unknown error' : String(errorValue))
          }
          metricResults.push({
            name: metricName,
            promql,
            unit,
            data_points: extractDataPoints(raw),
          })
        } catch (error) {
          const message = errorMessage(error)
          errors.push(`${metricName}: ${message}`)
          metricResults.push({
            name: metricName,
            promql,
            unit,
            data_points: [],
            error: message,
          })
        }
      }

      let summary = `env=${config.env} service=${serviceLabel} 查询 ${metricNames.length} 个指标`
      summary += errors.length > 0
        ? `，${errors.length} 个失败：${errors.join('; ')}`
        : '，全部成功'
      return buildEvidence({
        source: SOURCE,
        type: TYPE_METRIC,
        data: {
          env: config.env,
          service: service ?? null,
          start: args.start,
          end: args.end,
          step,
          metrics: metricResults,
        },
        summary,
        confidence: errors.length > 0 ? 0.5 : 0.95,
        refs: refs(),
      }) as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_list_alerts',
    description:
      'List currently firing Prometheus alerts via /api/v1/rules, optionally filtered by service label. '
      + 'Read-only. Use together with sentry_query_metrics to align alert times with metric inflection points.',
    parameters: {
      service: { type: 'string', description: 'Filter alerts by their service label.' },
      state: {
        type: 'string',
        default: 'firing',
        description: 'Alert state filter. Kept for CLI parity: like the original script, only firing alerts are returned.',
      },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Prometheus.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const service = args.service
      // `args.state` is deliberately unread: the original script parsed
      // --state and never used it, hardcoding `state == "firing"`. Recorded
      // drift, ported verbatim (see module doc and promql.ts).

      // Original ordering: endpoint check first, then demo.
      if (ctx.prometheus.endpoint.length === 0) return missingEndpointError(TYPE_ALERT)

      if (args.demo === true) {
        const svc = service || 'order-service'
        return buildEvidence({
          source: SOURCE,
          type: TYPE_ALERT,
          data: {
            env: config.env,
            service: service ?? null,
            demo: true,
            alerts: [
              {
                name: `${svc}-latency-high`,
                state: 'firing',
                severity: 'p1',
                started_at: nowIso(),
                labels: { service: svc, severity: 'p1' },
                annotations: { summary: `${svc} P99 延迟超过阈值` },
                value: '3.2',
              },
            ],
          },
          summary: `[demo] env=${config.env} service=${svc} 发现 1 个 firing 告警。`,
          confidence: 1.0,
          refs: [envRef],
        }) as unknown as JsonValue
      }

      try {
        const raw = await ctx.prometheus.rules()
        const alerts = extractFiringAlerts(raw, service)
        return buildEvidence({
          source: SOURCE,
          type: TYPE_ALERT,
          data: {
            env: config.env,
            service: service ?? null,
            alerts,
          },
          summary: `env=${config.env} service=${service || 'all'} 发现 ${alerts.length} 个 firing 告警`,
          confidence: 0.95,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE_ALERT,
          error: errorMessage(error),
          summary: `查询 Prometheus 告警失败：${errorMessage(error)}`,
          refs: refs(),
        }) as unknown as JsonValue
      }
    },
  }))
}
