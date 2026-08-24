#!/usr/bin/env node
/**
 * Phase 0 programmatic host.
 *
 * Boots the minimal service spine (system-prompt → tools → skills), mounts the
 * probe plugin, then asserts both registration paths before exiting non-zero
 * on any failure. The declarative equivalent lives in `../cordis.yml`.
 */

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DbxService from '@dsh-sentry/service-dbx'
import GreptimeDbService from '@dsh-sentry/service-greptimedb'
import PrometheusService from '@dsh-sentry/service-prometheus'
import TraceService from '@dsh-sentry/service-trace'
import ZadigService from '@dsh-sentry/service-zadig'
import * as dbInspector from '@dsh-sentry/tool-db-inspector'
import * as hello from '@dsh-sentry/tool-hello'
import * as logAnalyzer from '@dsh-sentry/tool-log-analyzer'
import * as metricsInspector from '@dsh-sentry/tool-metrics-inspector'
import * as redisInspector from '@dsh-sentry/tool-redis-inspector'
import * as sentrySkills from '@dsh-sentry/sentry-skills'
import * as traceAnalyzer from '@dsh-sentry/tool-trace-analyzer'
import * as zadigInspector from '@dsh-sentry/tool-zadig-inspector'

const root = new Context()

await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)
await root.plugin(SkillRegistry)
await root.plugin(hello)
await root.plugin(GreptimeDbService, {
  endpoint: 'https://greptimedb.example.invalid',
  usernameRef: 'GREPTIMEDB_LOCAL_USERNAME',
  passwordRef: 'GREPTIMEDB_LOCAL_PASSWORD',
})
await root.plugin(logAnalyzer, { env: 'local' })
await root.plugin(TraceService, {
  endpoint: 'https://grafana.example.invalid',
  usernameRef: 'GRAFANA_LOCAL_USERNAME',
  passwordRef: 'GRAFANA_LOCAL_PASSWORD',
})
await root.plugin(traceAnalyzer, { env: 'local', datasourceUid: 'GreptimeDB-Jaeger' })
await root.plugin(PrometheusService, { endpoint: 'http://prometheus.example.invalid' })
await root.plugin(metricsInspector, { env: 'local' })
await root.plugin(DbxService, {
  endpoint: 'https://dbx.example.invalid',
  passwordRef: 'DBX_REDIS_PASSWORD',
})
await root.plugin(dbInspector, { env: 'local', database: 'novo_commctl_config' })
await root.plugin(redisInspector, { env: 'local' })
await root.plugin(ZadigService, {
  endpoint: 'https://zadig.example.invalid',
  project: 'novo-one',
  envName: 'dev-env',
})
await root.plugin(zadigInspector, { env: 'local' })
await root.plugin(sentrySkills)

const tool = root.tools.get('sentry_hello')
if (tool === undefined) {
  throw new Error('FAIL: tool "sentry_hello" was not registered')
}

for (const name of ['sentry_query_logs', 'sentry_list_log_services', 'sentry_fetch_trace', 'sentry_query_metrics', 'sentry_list_alerts', 'sentry_query_db', 'sentry_query_redis', 'sentry_query_zadig']) {
  if (root.tools.get(name) === undefined) {
    throw new Error(`FAIL: tool "${name}" was not registered`)
  }
}

const skills = await root.skills.list()
for (const expected of ['sentry-hello', 'log-analyzer']) {
  if (!skills.some(skill => skill.name === expected)) {
    throw new Error(`FAIL: skill "${expected}" was not registered`)
  }
}

console.log('Phase 0 OK')
console.log('tool parameters:', JSON.stringify(tool.parameters))
console.log('tools:', ['sentry_hello', 'sentry_query_logs', 'sentry_list_log_services', 'sentry_fetch_trace', 'sentry_query_metrics', 'sentry_list_alerts', 'sentry_query_db', 'sentry_query_redis', 'sentry_query_zadig'].join(', '))
console.log('skills:', skills.map(skill => skill.name).join(', '))

await root.fiber.dispose()
