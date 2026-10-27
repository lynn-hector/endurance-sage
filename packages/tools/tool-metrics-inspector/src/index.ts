/**
 * Metrics inspector tools: query Prometheus metrics and list firing alerts,
 * returning the unified evidence envelope.
 *
 * Port of the original `skills/metrics-inspector` (SKILL.md +
 * `scripts/query_metrics.py` + `scripts/list_alerts.py`). The CLI-era flag
 * set became JSON-Schema tools (query / list-alerts / list-metrics from the
 * scripts; later additions serve alert triage — see each `defineTool`
 * registration below for the authoritative list).
 *
 * `--metrics` (a comma-separated string) became a string array; `--env`
 * became the `env` label in `Config` — the environment is an assembly-time
 * choice now, and the label survives only as evidence metadata. The original
 * `config/{env}.yml:metrics` evidence refs became `env:<env>`; the datasource
 * ref is the Provider's `backendRef`.
 *
 * Seam migration (structure-only, wording preserved): PromQL execution,
 * rules walking and metric-name discovery go through the backend-neutral
 * `ctx.metricsStore` Definition; the Alertmanager leg keeps the named
 * `ctx.alertmanager` service (no second real backend exists, see the
 * architecture plan). Evidence `data` gains a `backend_ref` field like the
 * sibling legs.
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
 * - dry-run evidence describes the backend-neutral request (promql, mode,
 *   window/step) plus `backend_ref`; the concrete URL/method/body are
 *   Provider transport detail and no longer cross the seam;
 * - evidence refs use the `env:<env>` + Provider `backendRef` style instead
 *   of the removed `config/{env}.yml` path (the missing-endpoint error
 *   messages keep their original wording verbatim, path included);
 * - transport failure wording is unified in the service layer
 *   (`请求 Prometheus 失败: ...`).
 *
 * @module @dsh-sentry/tool-metrics-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError, nowIso } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type { MetricsStore } from '@dsh-sentry/metrics-store'
import type {} from '@dsh-sentry/metrics-store'
import type {} from '@dsh-sentry/service-alertmanager'
import type {} from '@dsh-sentry/service-env-provider'
import { extractAmAlerts, extractAmSilences } from './am.ts'
import { buildPromql, metricUnit, parseIso8601 } from './promql.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-metrics-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'metricsStore', 'alertmanager']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /**
   * Env label fallback when the assembly files are unreadable (local dev
   * hosts set it explicitly; matrix assemblies omit it). Evidence metadata
   * only — the loaded datasource config already is one environment.
   */
  env?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
})

const SOURCE = 'metrics-inspector'
const TYPE_METRIC = 'metric'
const TYPE_ALERT = 'alert'
const TYPE_ALERT_RULE = 'alert-rule'
const TYPE_AM_ALERT = 'am-alert'
const TYPE_AM_SILENCE = 'am-silence'
const DEFAULT_METRICS = ['qps', 'latency_p99', 'error_rate']
const DEFAULT_STEP = '15s'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register the metrics-inspector tools (metrics + alerts). */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

  /** The store, env label and lease one call fixed at its start. */
  interface MetricsCall {
    env: string
    store: MetricsStore
    release: () => Promise<void>
  }

  /** AM calls lease the named alertmanager service instead (typed via the slot). */
  interface AmCall {
    env: string
    store: Context['alertmanager']
    release: () => Promise<void>
  }

  // Session-routed hosts resolve the Provider through the calling session's
  // binding; legacy hosts keep the global services and assembly env label.
  const routeMetrics = async (exec: ToolRunContext): Promise<MetricsCall> => {
    const envProviders = ctx.get('envProviders')
    if (envProviders !== undefined) {
      const lease = await envProviders.forCall(exec)
      return { env: lease.env, store: lease.require('metricsStore'), release: lease.release }
    }
    return { env: liveEnv(), store: ctx.metricsStore, release: async () => {} }
  }

  const routeAlertmanager = async (exec: ToolRunContext): Promise<AmCall> => {
    const envProviders = ctx.get('envProviders')
    if (envProviders !== undefined) {
      const lease = await envProviders.forCall(exec)
      return { env: lease.env, store: lease.require('alertmanager'), release: lease.release }
    }
    return { env: liveEnv(), store: ctx.alertmanager, release: async () => {} }
  }

  /** Original endpoint guard, shared by both scripts, original wording kept. */
  const missingEndpointError = (type: string, env: string): JsonValue =>
    buildEvidenceError({
      source: SOURCE,
      type,
      error: `config/${env}.yml 中 datasources.metrics.endpoint 未配置`,
      summary: `缺少 metrics 数据源配置：config/${env}.yml:metrics.endpoint`,
      refs: [`env:${env}`],
    }) as unknown as JsonValue

  ctx.tools.register(defineTool({
    name: 'sentry_query_metrics',
    description:
      'Query Prometheus metrics over a time range or at a single instant (`time`) and return one evidence envelope per call. '
      + 'Read-only. `metrics` accepts built-in short names '
      + '(qps / latency_p99 / latency_p95 / error_rate / cpu / memory) or raw PromQL expressions; '
      + 'at least qps, latency_p99 and error_rate should be queried together when triaging. '
      + 'Prefer a tight time window (5–30 minutes around the symptom).',
    parameters: {
      start: { type: 'string', description: 'Range start, ISO8601 (e.g. 2026-07-22T10:00:00Z). Required in range mode; ignored when `time` is given.' },
      end: { type: 'string', description: 'Range end, ISO8601. Required in range mode; ignored when `time` is given.' },
      time: {
        type: 'string',
        description: 'Instant mode: ISO8601 evaluation time (e.g. 2026-07-22T10:00:00Z). When given, start/end/step are ignored and the query runs as a single-point instant query — use it to pin an exact moment (e.g. the alert firing time).',
      },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        default: [...DEFAULT_METRICS],
        description: `Metric short names or raw PromQL expressions. Defaults to ${DEFAULT_METRICS.join(',')}.`,
      },
      service: { type: 'string', description: 'Service name, matched against the `app` label on this cluster.' },
      step: { type: 'string', default: DEFAULT_STEP, description: `Query resolution step. Defaults to ${DEFAULT_STEP}.` },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed requests, do not send.' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Prometheus.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: MetricsCall | undefined
      try {
        call = await routeMetrics(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store: metricsStore } = call
        const envRef = `env:${env}`
        const refs = (): string[] => [envRef, metricsStore.backendRef]

        const instant = typeof args.time === 'string' && args.time.length > 0
        if (!instant && (typeof args.start !== 'string' || typeof args.end !== 'string')) {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE_METRIC,
            error: '缺少 time（instant 模式）或 start/end（range 模式）二者之一',
            summary: 'time 与 start/end 必须提供其中一组',
            refs: [envRef],
          }) as unknown as JsonValue
        }

        const service = args.service
        const serviceLabel = service || 'all'

        // Original ordering: endpoint check first, then demo, then time parsing.
        if (!metricsStore.configured) return missingEndpointError(TYPE_METRIC, env)

        if (args.demo === true) {
          // The original demo path used the raw (untrimmed) --metrics split.
          const metricNames = args.metrics ?? DEFAULT_METRICS
          const svc = service || 'all-services'
          const metricResults = metricNames.map(metricName => ({
            name: metricName,
            promql: buildPromql(metricName, service),
            unit: metricUnit(metricName),
            // instant 单点；range 两点（第二点带峰值）——instant 时 end 是 undefined，
            // 无条件两点会产出一个无时间戳的幽灵点
            data_points: instant
              ? [{
                  timestamp: args.time,
                  value: metricName === 'latency_p99' ? 120.0 : 0.05,
                  labels: { service: svc },
                }]
              : [
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
              env,
              service: service ?? null,
              // instant 模式忽略 start/end，也不回显——证据不声称查过从未查询的区间
              start: instant ? null : args.start,
              end: instant ? null : args.end,
              time: args.time ?? null,
              mode: instant ? 'instant' : 'range',
              demo: true,
              metrics: metricResults,
            },
            summary: `[demo] env=${env} service=${svc} 查询 ${metricNames.length} 个指标，返回演示数据。`,
            confidence: 1.0,
            refs: [envRef],
          }) as unknown as JsonValue
        }

        let startTs: number
        let endTs: number
        try {
          startTs = parseIso8601(instant ? args.time! : args.start!)
          endTs = instant ? startTs : parseIso8601(args.end!)
        } catch (error) {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE_METRIC,
            error: `时间格式错误: ${errorMessage(error)}`,
            summary: instant ? 'time 不是合法的 ISO8601 时间' : '--start 或 --end 不是合法的 ISO8601 时间',
            refs: [envRef],
          }) as unknown as JsonValue
        }

        const step = args.step ?? DEFAULT_STEP
        const metricNames = (args.metrics ?? DEFAULT_METRICS)
          .map(metricName => metricName.trim())
          .filter(metricName => metricName.length > 0)

        if (args.dryRun === true) {
          // Deviation (see module doc): one envelope with every metric's
          // backend-neutral request; the original printed only the first and
          // exited. The concrete URL/method/body are Provider transport detail
          // and no longer cross the seam; backend_ref carries the identity.
          const requests = metricNames.map((metricName) => ({
            query: buildPromql(metricName, service),
            mode: instant ? 'instant' : 'range',
            ...(instant
              ? { time_sec: startTs }
              : { start_sec: startTs, end_sec: endTs, step }),
          }))
          return buildEvidence({
            source: SOURCE,
            type: TYPE_METRIC,
            data: {
              env,
              service: service ?? null,
              start: instant ? null : args.start,
              end: instant ? null : args.end,
              step,
              dry_run: true,
              backend_ref: metricsStore.backendRef,
              requests,
            },
            summary: `[dry-run] env=${env} service=${serviceLabel} 构造 ${metricNames.length} 个查询请求，未发送。`,
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
            const dataPoints = instant
              ? await metricsStore.queryInstantMetrics({ promql, timeSec: startTs })
              : await metricsStore.queryRangeMetrics({ promql, startSec: startTs, endSec: endTs, step })
            metricResults.push({
              name: metricName,
              promql,
              unit,
              mode: instant ? 'instant' : 'range',
              data_points: dataPoints,
            })
          } catch (error) {
            const message = errorMessage(error)
            errors.push(`${metricName}: ${message}`)
            metricResults.push({
              name: metricName,
              promql,
              unit,
              mode: instant ? 'instant' : 'range',
              data_points: [],
              error: message,
            })
          }
        }

        let summary = `env=${env} service=${serviceLabel} 查询 ${metricNames.length} 个指标`
        summary += errors.length > 0
          ? `，${errors.length} 个失败：${errors.join('; ')}`
          : '，全部成功'
        return buildEvidence({
          source: SOURCE,
          type: TYPE_METRIC,
          data: {
            env,
            service: service ?? null,
            start: instant ? null : args.start,
            end: instant ? null : args.end,
            step,
            mode: instant ? 'instant' : 'range',
            backend_ref: metricsStore.backendRef,
            metrics: metricResults,
          },
          summary,
          confidence: errors.length > 0 ? 0.5 : 0.95,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE_METRIC,
          error: errorMessage(error),
          summary: `指标查询失败: ${errorMessage(error)}`,
          refs: call === undefined ? [] : [`env:${call.env}`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_list_metrics',
    description:
      'List metric names active on this cluster within a recent time window '
      + '(Prometheus label values of __name__). Read-only. Use before writing raw PromQL: '
      + 'check which metrics actually exist, optionally narrowed by `match` substring '
      + '(e.g. "http", "go_", a service keyword). The built-in short names of '
      + 'sentry_query_metrics (qps/latency_p99/error_rate/...) cover common RED triage; '
      + 'this tool is the escape hatch for everything else.',
    parameters: {
      match: { type: 'string', description: 'Case-insensitive substring filter on metric names.' },
      windowMinutes: { type: 'number', default: 60, description: 'Look-back window; only metrics with samples in it are listed. Defaults to 60.' },
      limit: { type: 'number', default: 40000, description: 'Server-side cap on returned names. Defaults to 40000.' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Prometheus.' },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: MetricsCall | undefined
      try {
        call = await routeMetrics(exec)
        const { env, store: metricsStore } = call
        const envRef = `env:${env}`
        const refs = (): string[] => [envRef, metricsStore.backendRef]
        const match = typeof args.match === 'string' && args.match.length > 0 ? args.match.toLowerCase() : null
        const windowMinutes = typeof args.windowMinutes === 'number' && args.windowMinutes > 0 ? args.windowMinutes : 60
        const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 40000

        if (args.dryRun === true) {
          return buildEvidence({
            source: SOURCE,
            type: TYPE_METRIC,
            data: { dry_run: true, backend_ref: metricsStore.backendRef, window_minutes: windowMinutes, limit },
            summary: `[dry-run] 构造指标名清单查询请求（窗口 ${windowMinutes} 分钟），未发送。`,
            confidence: 1.0,
            refs: refs(),
          }) as unknown as JsonValue
        }

        if (args.demo === true) {
          const demoNames = [
            'go_goroutines',
            'http_server_requests_seconds_bucket',
            'http_server_requests_seconds_count',
            'http_server_requests_seconds_sum',
            'process_cpu_seconds_total',
            'process_resident_memory_bytes',
            'up',
          ]
          return listMetricsEvidence(env, envRef, demoNames, match, windowMinutes, true, undefined)
        }

        const names = await metricsStore.listMetricNames({ windowMinutes, limit })
        return listMetricsEvidence(env, envRef, names, match, windowMinutes, false, undefined)
      } catch (error) {
        return listMetricsEvidence(
          call?.env ?? 'unknown',
          `env:${call?.env ?? 'unknown'}`,
          [],
          typeof args.match === 'string' && args.match.length > 0 ? args.match.toLowerCase() : null,
          typeof args.windowMinutes === 'number' && args.windowMinutes > 0 ? args.windowMinutes : 60,
          false,
          errorMessage(error),
        )
      } finally {
        await call?.release()
      }
    },
  }))

  /** Metric-list evidence envelope: sorted names, optional substring filter, prefix histogram. */
  function listMetricsEvidence(
    env: string,
    envRef: string,
    names: string[],
    match: string | null,
    windowMinutes: number,
    demo: boolean,
    error: string | undefined,
  ): JsonValue {
    const filtered = match === null ? names : names.filter(n => n.toLowerCase().includes(match))
    const prefixes: Record<string, number> = {}
    for (const n of filtered) {
      const prefix = n.split('_')[0] ?? n
      prefixes[prefix] = (prefixes[prefix] ?? 0) + 1
    }

    let summary: string
    let confidence: number
    if (error !== undefined) {
      summary = `指标名清单查询失败: ${error}`
      confidence = 0.0
    } else {
      summary = `env=${env} 最近 ${windowMinutes} 分钟内共 ${filtered.length} 个指标`
      if (match !== null) summary += `（match 过滤: "${match}"，过滤前 ${names.length} 个）`
      confidence = demo ? 0.5 : 0.95
    }

    return buildEvidence({
      source: SOURCE,
      type: TYPE_METRIC,
      data: {
        env,
        window_minutes: windowMinutes,
        match,
        metric_count: filtered.length,
        prefix_histogram: prefixes,
        metrics: filtered,
        demo,
        error: error ?? null,
      },
      summary,
      confidence,
      refs: [envRef],
    }) as unknown as JsonValue
  }

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
    async execute(args, exec) {
      let call: MetricsCall | undefined
      try {
        call = await routeMetrics(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store: metricsStore } = call
        const envRef = `env:${env}`
        const refs = (): string[] => [envRef, metricsStore.backendRef]
        const service = args.service
        // `args.state` is deliberately unread: the original script parsed
        // --state and never used it, hardcoding `state == "firing"`. Recorded
        // drift, ported verbatim (see module doc and promql.ts).

        // Original ordering: endpoint check first, then demo.
        if (!metricsStore.configured) return missingEndpointError(TYPE_ALERT, env)

        if (args.demo === true) {
          const svc = service || 'order-service'
          return buildEvidence({
            source: SOURCE,
            type: TYPE_ALERT,
            data: {
              env,
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
            summary: `[demo] env=${env} service=${svc} 发现 1 个 firing 告警。`,
            confidence: 1.0,
            refs: [envRef],
          }) as unknown as JsonValue
        }

        try {
          const alerts = await metricsStore.listFiringAlerts(service !== undefined ? { service } : {})
          return buildEvidence({
            source: SOURCE,
            type: TYPE_ALERT,
            data: {
              env,
              service: service ?? null,
              backend_ref: metricsStore.backendRef,
              alerts,
            },
            summary: `env=${env} service=${service || 'all'} 发现 ${alerts.length} 个 firing 告警`,
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
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_get_alert_rule',
    description:
      'Look up alert rule definitions by name substring (case-insensitive) via /api/v1/rules: '
      + 'returns the PromQL expression, for-duration, labels, annotations and current state of every matching rule, '
      + 'firing or not. Read-only. First step of alert analysis: take the alert name from the notification, '
      + 'get the expression, then drill into its metrics.',
    parameters: {
      name: { type: 'string', required: true, description: 'Rule name substring, e.g. "GoGrpcP95LatencyHigh".' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Prometheus.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: MetricsCall | undefined
      try {
        call = await routeMetrics(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store: metricsStore } = call
        const envRef = `env:${env}`
        const refs = (): string[] => [envRef, metricsStore.backendRef]

        // Original ordering（与 sentry_query_metrics / sentry_list_alerts 一致）：先查配置再谈 demo——
        // 半配置宿主上 demo 输出不该被当成真实证据
        if (!metricsStore.configured) return missingEndpointError(TYPE_ALERT_RULE, env)
        if (args.demo === true) {
          return buildEvidence({
            source: SOURCE,
            type: TYPE_ALERT_RULE,
            data: {
              env,
              name_filter: args.name,
              demo: true,
              rules: [{
                name: 'GoGrpcP95LatencyHigh',
                group: 'GoServiceL2Alerts',
                query: 'histogram_quantile(0.95, sum by (le, grpc_service, grpc_method) (rate(grpc_server_handling_seconds_bucket{namespace="novo-one"}[5m]))) > 1',
                duration: 180,
                labels: { severity: 'l2' },
                annotations: { summary: 'Go gRPC P95 耗时过高' },
                state: 'firing',
                firing: [{ active_at: '2026-10-10T07:14:53Z', value: '2.125', labels: { grpc_method: 'GetConfigurationXML' } }],
              }],
              match_count: 1,
            },
            summary: `[demo] env=${env} 规则名过滤 "${args.name}" 命中 1 条。`,
            confidence: 1.0,
            refs: [envRef],
          }) as unknown as JsonValue
        }

        try {
          const rules = await metricsStore.listAlertRules({ nameContains: args.name })
          return buildEvidence({
            source: SOURCE,
            type: TYPE_ALERT_RULE,
            data: {
              env,
              name_filter: args.name,
              backend_ref: metricsStore.backendRef,
              rules,
              match_count: rules.length,
            },
            summary: `env=${env} 规则名过滤 "${args.name}" 命中 ${rules.length} 条`,
            confidence: rules.length > 0 ? 0.95 : 0.4,
            refs: refs(),
          }) as unknown as JsonValue
        } catch (error) {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE_ALERT_RULE,
            error: errorMessage(error),
            summary: `查询 Prometheus 告警规则失败：${errorMessage(error)}`,
            refs: refs(),
          }) as unknown as JsonValue
        }
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_list_am_alerts',
    description:
      'List active alert instances from Alertmanager (behind Grafana): name, labels, annotations, '
      + 'active_at/ends_at, fingerprint, receivers. Complements sentry_list_alerts with the routing view — '
      + 'use it for the global firing picture and correlated alerts before drilling into a single rule. Read-only.',
    parameters: {
      match: { type: 'string', description: 'Case-insensitive substring filter on the alert name.' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: AmCall | undefined
      try {
        call = await routeAlertmanager(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store: alertmanager } = call
        const envRef = `env:${env}`
        const refs = (): string[] => [envRef, alertmanager.backendRef]

        if (args.demo === true) {
          return buildEvidence({
            source: SOURCE,
            type: TYPE_AM_ALERT,
            data: {
              env,
              demo: true,
              alerts: [{
                name: 'GoGrpcP95LatencyHigh',
                status: { state: 'active', inhibited_by: [], silenced_by: [] },
                labels: { severity: 'l2', cluster: 'dev-platform-hosted-1' },
                annotations: { summary: 'Go gRPC P95 耗时过高' },
                active_at: '2026-10-10T07:14:53Z',
                ends_at: '2026-10-10T07:44:53Z',
                fingerprint: 'demo',
                receivers: ['feishu-ops'],
              }],
            },
            summary: `[demo] env=${env} 1 个活跃告警。`,
            confidence: 1.0,
            refs: refs(),
          }) as unknown as JsonValue
        }
        try {
          const raw = await alertmanager.listAlerts()
          const alerts = extractAmAlerts(raw, args.match)
          return buildEvidence({
            source: SOURCE,
            type: TYPE_AM_ALERT,
            data: { env, match: args.match ?? null, backend_ref: alertmanager.backendRef, alerts, count: alerts.length },
            summary: `env=${env} Alertmanager 活跃告警 ${alerts.length} 条${args.match ? `（过滤 "${args.match}"）` : ''}`,
            confidence: 0.95,
            refs: refs(),
          }) as unknown as JsonValue
        } catch (error) {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE_AM_ALERT,
            error: errorMessage(error),
            summary: `查询 Alertmanager 活跃告警失败：${errorMessage(error)}`,
            refs: refs(),
          }) as unknown as JsonValue
        }
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_list_am_silences',
    description:
      'List Alertmanager silences (active and expired, optional state filter). Use to check whether an alert '
      + 'was muted — a silenced alert stops notifying while still firing. Read-only.',
    parameters: {
      state: { type: 'string', description: 'Filter by silence state: "active" or "expired". Omit for all.' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: AmCall | undefined
      try {
        call = await routeAlertmanager(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store: alertmanager } = call
        const envRef = `env:${env}`
        const refs = (): string[] => [envRef, alertmanager.backendRef]
        const state = args.state
        // 非法值报错而不是静默丢掉过滤条件——「没有匹配的静默」和「过滤没执行过」
        // 对"这条告警被静音了吗"是完全不同的答案
        if (state !== undefined && state !== 'active' && state !== 'expired') {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE_AM_SILENCE,
            error: `state 仅支持 active 或 expired（收到: ${state}），不传则返回全部`,
            summary: 'state 参数不合法',
            refs: [envRef],
          }) as unknown as JsonValue
        }
        if (args.demo === true) {
          return buildEvidence({
            source: SOURCE,
            type: TYPE_AM_SILENCE,
            data: {
              env,
              demo: true,
              silences: [{
                id: 'demo-sil',
                status: { state: 'active' },
                matchers: [{ name: 'cluster', value: 'dev-platform-hosted-1', is_regex: false }],
                starts_at: '2026-10-01T00:00:00Z',
                ends_at: '2026-10-20T00:00:00Z',
                comment: '升级窗口静默',
                created_by: 'ops',
              }],
            },
            summary: `[demo] env=${env} 1 条静默。`,
            confidence: 1.0,
            refs: refs(),
          }) as unknown as JsonValue
        }
        try {
          const raw = await alertmanager.listSilences()
          const silences = extractAmSilences(raw, state)
          return buildEvidence({
            source: SOURCE,
            type: TYPE_AM_SILENCE,
            data: { env, state: state ?? null, backend_ref: alertmanager.backendRef, silences, count: silences.length },
            summary: `env=${env} Alertmanager 静默 ${silences.length} 条${state ? `（state=${state}）` : ''}`,
            confidence: 0.95,
            refs: refs(),
          }) as unknown as JsonValue
        } catch (error) {
          return buildEvidenceError({
            source: SOURCE,
            type: TYPE_AM_SILENCE,
            error: errorMessage(error),
            summary: `查询 Alertmanager 静默失败：${errorMessage(error)}`,
            refs: refs(),
          }) as unknown as JsonValue
        }
      } finally {
        await call?.release()
      }
    },
  }))
}
