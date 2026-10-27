/**
 * One-shot connectivity probe for a sentry data-source leg:
 *   pnpm --filter @dsh-sentry/dev exec tsx src/probe.ts <腿> [环境]
 *
 * 腿：greptimedb | trace | prometheus | alertmanager | dbx | rocketmq | zadig | grafana-datasources
 * 环境：envs.yml 行名或短码（DP0/DP1/DC0/TP0/TP1/TC0/SC1/SC2），缺省 dev-platform-hosted-0。
 *
 * Boots the real credentials plane ($DSH_HOME/.credentials.yaml) plus the
 * target service and performs one harmless read call. Secrets are resolved
 * internally and NEVER printed — only HTTP outcomes and payload shapes.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { resolveCredential } from '@dsh-sentry/datasource'
import { credentialStorePath, resolveEnvName, type Matrix } from '@dsh-sentry/env-matrix'
import GreptimeDbService from '@dsh-sentry/service-greptimedb'
import RocketMqService from '@dsh-sentry/service-rocketmq'
import ZadigService from '@dsh-sentry/service-zadig'
import DbxService from '@dsh-sentry/service-dbx'
import TraceService from '@dsh-sentry/service-trace'
import PrometheusService from '@dsh-sentry/service-prometheus'
import AlertmanagerService from '@dsh-sentry/service-alertmanager'
import { parse } from 'yaml'

const LEGS = ['greptimedb', 'trace', 'prometheus', 'alertmanager', 'dbx', 'rocketmq', 'zadig', 'grafana-datasources'] as const
type Leg = (typeof LEGS)[number]

const which = process.argv[2] ?? ''
const envInput = process.argv[3] ?? 'dev-platform-hosted-0'
if (!LEGS.includes(which as Leg)) {
  console.error(`usage: tsx src/probe.ts <${LEGS.join('|')}> [环境，缺省 dev-platform-hosted-0]`)
  process.exit(2)
}
const leg = which as Leg

const ENVS_YML = new URL('../../agent/envs.yml', import.meta.url)
const matrix = parse(readFileSync(ENVS_YML, 'utf8')) as Matrix
const envName = resolveEnvName(envInput, matrix)
const row = envName === undefined ? undefined : matrix[envName]
if (envName === undefined || row === undefined) {
  console.error(`未知环境: ${envInput}（envs.yml 中没有这一行，支持 DP0/DP1/DC0/TP0/TP1/TC0/SC1/SC2 短码）`)
  process.exit(2)
}
console.log(` probing ${leg} @ ${envName}`)

const ctx = new Context()

// 新版 dsh CLI 写的凭据库是 versioned layout（`version: 1` + `refs:` 嵌套），
// 而 rc.7/rc.8 的 LocalCredentialProvider 只认旧的平铺格式。probe 前把 refs
// 摊平成临时文件喂给 provider——凭据值只进内存与 0600 临时文件，不落 repo。
const storePath = credentialStorePath()
const rawDoc = parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>
const refs = (rawDoc['refs'] ?? rawDoc) as Record<string, unknown>
const flat = Object.entries(refs)
  .filter(([, v]) => typeof v === 'string' && v.length > 0)
  .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  .join('\n')
const tmpStore = join(mkdtempSync(join(tmpdir(), 'sentry-probe-')), 'credentials.yaml')
writeFileSync(tmpStore, `${flat}\n`, { mode: 0o600 })
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
await ctx.plugin(LocalCredentialProvider, { path: tmpStore, dshHome, watch: false } as never)

function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /password|token|secret|access_?key|jsessionid/i.test(k) ? '<masked>' : maskSecrets(v)
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
  if (leg === 'greptimedb') {
    await ctx.plugin(GreptimeDbService, {
      endpoint: row.greptimedb.endpoint!,
      database: row.greptimedb.database ?? 'public',
      ...(row.greptimedb.tokenRef !== undefined
        ? { connectTokenRef: row.greptimedb.tokenRef }
        : { usernameRef: row.greptimedb.usernameRef, passwordRef: row.greptimedb.passwordRef }),
    })
    const services = await ctx.logStore.listLogServices({ logType: 'go' })
    console.log(`GREPTIMEDB PROBE OK — recent log workloads: ${services.length}`)
    if (services.length > 0) console.log(`  sample: ${services.slice(0, 5).join(', ')}`)
  } else if (leg === 'trace') {
    await ctx.plugin(TraceService, {
      mode: 'grafana-jaeger',
      endpoint: row.grafana.endpoint!,
      usernameRef: row.grafana.usernameRef,
      passwordRef: row.grafana.passwordRef,
      datasourceUid: row.grafana.greptimedbJaegerDatasourceUid ?? 'GreptimeDB-Jaeger',
    })
    // A probe id that cannot exist: a parsed "not found" shape means auth +
    // datasource wiring are OK; HTTP 401 would mean credentials are wrong.
    // 第四个参数可传真实 traceId 验证完整取数路径。
    const result = await ctx.traceStore.queryTrace({
      traceId: process.argv[4] ?? 'probe0000000000000000000000000000',
    })
    console.log('TRACE PROBE OK — response shape:')
    console.log(summarize(result))
  } else if (leg === 'dbx') {
    await ctx.plugin(DbxService, {
      endpoint: row.dbx.endpoint!,
      passwordRef: row.dbx.passwordRef,
    })
    // Harmless read through the backend-neutral seam: exercises login,
    // postgres connection discovery and the execute path in one call.
    const result = await ctx.dbStore.querySql({ sql: 'SELECT 1', database: 'postgres' })
    console.log('DBX PROBE OK — querySql through dbStore (shape):')
    console.log(summarize(result))
  } else if (leg === 'rocketmq') {
    await ctx.plugin(RocketMqService, {
      endpoint: row.rocketmq.endpoint!,
      usernameRef: row.rocketmq.usernameRef,
      passwordRef: row.rocketmq.passwordRef,
    })
    // Lightest harmless check through the concrete Provider: console login
    // plus the /topic/list.query session validation.
    await (ctx.mqStore as RocketMqService).ensureSession()
    console.log('ROCKETMQ PROBE OK — session established')
  } else if (leg === 'prometheus') {
    await ctx.plugin(PrometheusService, {
      endpoint: '',
      grafanaEndpoint: row.grafana.endpoint!,
      datasourceUid: row.prometheus.datasourceUid,
      ...(row.prometheus.tokenRef !== undefined
        ? { tokenRef: row.prometheus.tokenRef }
        : { usernameRef: row.grafana.usernameRef, passwordRef: row.grafana.passwordRef }),
    })
    const endSec = Math.floor(Date.now() / 1000)
    // 经 metricsStore seam 探活：一次 'up' range 查询同时验证认证、代理与取数路径。
    const points = await ctx.metricsStore.queryRangeMetrics({
      promql: 'up',
      startSec: endSec - 600,
      endSec,
      step: '60s',
    })
    const series = new Map<string, number>()
    for (const point of points) {
      const key = JSON.stringify(point.labels)
      series.set(key, (series.get(key) ?? 0) + 1)
    }
    console.log(`PROMETHEUS PROBE OK — 'up' returned ${series.size} series`)
    let shown = 0
    for (const [labels, count] of series) {
      if (shown >= 3) break
      console.log(`  labels=${labels} points=${count}`)
      shown++
    }
  } else if (leg === 'alertmanager') {
    await ctx.plugin(AlertmanagerService, {
      grafanaEndpoint: row.grafana.endpoint!,
      datasourceUid: row.grafana.alertmanagerDatasourceUid ?? 'alertmanager',
      usernameRef: row.grafana.usernameRef,
      passwordRef: row.grafana.passwordRef,
    })
    const alerts = await ctx.alertmanager.listAlerts()
    const count = Array.isArray(alerts) ? alerts.length : -1
    console.log(`ALERTMANAGER PROBE OK — ${count} active alert(s)`)
  } else if (leg === 'zadig') {
    await ctx.plugin(ZadigService, {
      endpoint: row.zadig.endpoint!,
      project: row.zadig.project!,
      envName: row.zadig.envName!,
      tokenRef: row.zadig.tokenRef,
    })
    const services = await ctx.zadig.fetchServices()
    console.log(`ZADIG PROBE OK — ${services.length} workloads (envName=${row.zadig.envName})`)
    for (const svc of services.slice(0, 5)) {
      console.log(`  ${svc.name} | ${svc.status} | ${svc.build_time ?? '-'} build=${svc.build_id ?? '-'} branch=${svc.branch ?? '-'}`)
    }
  } else if (leg === 'grafana-datasources') {
    // 校准用：列出该环境 Grafana 的全部数据源（name/type/uid），
    // 找 jaeger 类型的真实 uid 填回 envs.yml 的 grafana.greptimedbJaegerDatasourceUid。
    // 认证走表单登录拿 session cookie（tst 实例禁用 basic auth，与 trace 服务同路径）。
    const username = row.grafana.usernameRef ? await resolveCredential(ctx, row.grafana.usernameRef) : undefined
    const password = row.grafana.passwordRef ? await resolveCredential(ctx, row.grafana.passwordRef) : undefined
    const base = row.grafana.endpoint!.replace(/\/+$/, '')
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: username, password }),
      redirect: 'manual',
    })
    if (login.status !== 200) throw new Error(`POST /login → HTTP ${login.status}`)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    if (!cookie) throw new Error('登录成功但未返回 session cookie')
    const res = await fetch(`${base}/api/datasources`, { headers: { cookie } })
    if (!res.ok) throw new Error(`GET /api/datasources → HTTP ${res.status}`)
    const list = (await res.json()) as { name: string; type: string; uid: string; isDefault?: boolean }[]
    console.log(`GRAFANA DATASOURCES @ ${envName}:`)
    for (const ds of list) console.log(`  ${ds.type.padEnd(12)} uid=${ds.uid}  name=${ds.name}${ds.isDefault ? ' (default)' : ''}`)
  }
} catch (error) {
  console.error('PROBE FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
await ctx.fiber.dispose()
