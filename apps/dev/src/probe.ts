/**
 * One-shot connectivity probe for a sentry data-source service:
 *   pnpm --filter @dsh-sentry/dev exec tsx src/probe.ts <trace|dbx|rocketmq>
 *
 * Boots the real credentials plane ($DSH_HOME/.credentials.yaml) plus the
 * target service and performs one harmless read call. Secrets are resolved
 * internally and NEVER printed — only HTTP outcomes and payload shapes.
 */

import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import RocketMqService from '@dsh-sentry/service-rocketmq'
import ZadigService from '@dsh-sentry/service-zadig'
import DbxService from '@dsh-sentry/service-dbx'
import TraceService from '@dsh-sentry/service-trace'
import PrometheusService from '@dsh-sentry/service-prometheus'

const which = process.argv[2] ?? ''
if (which === '') {
  console.error('usage: tsx src/probe.ts <trace|dbx|rocketmq>')
  process.exit(2)
}

const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, undefined as never)

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /password|token|secret|access_?key/i.test(k) ? '<masked>' : maskSecrets(v)
    }
    return out
  }
  return value
}

function summarize(payload: unknown): string {
  const json = JSON.stringify(maskSecrets(payload))
  return json.length > 400 ? `${json.slice(0, 400)}…` : json
}

try {
  if (which === 'trace') {
    await ctx.plugin(TraceService, {
      mode: 'grafana-jaeger',
      endpoint: 'https://grafana.cn-0.dev.novo-one.com',
      usernameRef: 'GRAFANA_LOCAL_USERNAME',
      passwordRef: 'GRAFANA_LOCAL_PASSWORD',
    })
    // A probe id that cannot exist: a parsed "not found" shape means auth +
    // datasource wiring are OK; HTTP 401 would mean credentials are wrong.
    const result = await ctx.trace.queryTrace({ traceId: 'probe0000000000000000000000000000', datasourceUid: 'GreptimeDB-Jaeger' })
    console.log('TRACE PROBE OK — response shape:')
    console.log(summarize(result))
  } else if (which === 'dbx') {
    await ctx.plugin(DbxService, {
      endpoint: 'https://dbx.cn-0.dev.novo-one.com',
      passwordRef: 'DBX_PASSWORD',
    })
    const connection = await ctx.dbx.discoverConnection('postgres')
    console.log('DBX PROBE OK — discovered postgres connection (shape):')
    console.log(summarize(connection))
  } else if (which === 'rocketmq') {
    await ctx.plugin(RocketMqService, {
      endpoint: 'https://rocketmq.cn-0.test.novo-one.com',
      usernameRef: 'ROCKETMQ_LOCAL_USERNAME',
      passwordRef: 'ROCKETMQ_LOCAL_PASSWORD',
    })
    const session = await ctx.rocketmq.ensureSession()
    console.log(`ROCKETMQ PROBE OK — session established (jsessionid length ${session.jsessionid.length})`)
  } else if (which === 'prometheus') {
    await ctx.plugin(PrometheusService, {
      endpoint: '',
      grafanaEndpoint: 'https://grafana.cn-0.dev.novo-one.com',
      usernameRef: 'GRAFANA_LOCAL_USERNAME',
      passwordRef: 'GRAFANA_LOCAL_PASSWORD',
    })
    const endSec = Math.floor(Date.now() / 1000)
    const envelope = await ctx.prometheus.queryRange('up', endSec - 600, endSec, '60s')
    const result = (envelope as { data: { result: { metric: Record<string, string>; values: unknown[][] }[] } }).data.result
    console.log(`PROMETHEUS PROBE OK — 'up' returned ${result.length} series`)
    for (const series of result.slice(0, 3)) {
      console.log(`  labels=${JSON.stringify(series.metric)} points=${series.values.length}`)
    }
  } else if (which === 'zadig') {
    await ctx.plugin(ZadigService, {
      endpoint: 'https://zadig.yeastardigital.com',
      project: 'novo-one-helm-charts-project',
      envName: 'dev-client-hosted-0',
      tokenRef: 'ZADIG_API_TOKEN',
    })
    const services = await ctx.zadig.fetchServices()
    console.log(`ZADIG PROBE OK — ${services.length} workloads`)
    for (const svc of services.slice(0, 5)) {
      console.log(`  ${svc.name} | ${svc.status} | ${svc.build_time ?? '-'} build=${svc.build_id ?? '-'} branch=${svc.branch ?? '-'}`)
    }
  } else {
    console.error(`unknown probe target: ${which}`)
    process.exit(2)
  }
} catch (error) {
  console.error('PROBE FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
await ctx.fiber.dispose()
