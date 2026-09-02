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
import * as logAnalyzer from '@dsh-sentry/tool-log-analyzer'
import * as metricsInspector from '@dsh-sentry/tool-metrics-inspector'
import * as redisInspector from '@dsh-sentry/tool-redis-inspector'
import * as sentryPersona from '@dsh-sentry/sentry-persona'
import * as sentrySkills from '@dsh-sentry/sentry-skills'
import * as traceAnalyzer from '@dsh-sentry/tool-trace-analyzer'
import * as zadigInspector from '@dsh-sentry/tool-zadig-inspector'
import * as codeRepository from '@dsh-sentry/tool-code-repository'
import RocketMq from '@dsh-sentry/service-rocketmq'
import * as mqInspector from '@dsh-sentry/tool-mq-inspector'

const root = new Context()

await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)
await root.plugin(SkillRegistry)
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
await root.plugin(traceAnalyzer, { env: 'local', greptimedbJaegerDatasourceUid: 'GreptimeDB-Jaeger' })
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
await root.plugin(codeRepository, { env: 'local', baseDir: '/tmp/sentry-code-repos' })
await root.plugin(RocketMq, { endpoint: 'https://rocketmq.example.invalid', username: 'admin' })
await root.plugin(mqInspector, { env: 'local' })
await root.plugin(sentrySkills)
await root.plugin(sentryPersona)

for (const name of ['sentry_query_logs', 'sentry_list_log_services', 'sentry_fetch_trace', 'sentry_query_metrics', 'sentry_list_metrics', 'sentry_list_alerts', 'sentry_query_db', 'sentry_query_redis', 'sentry_query_zadig', 'sentry_search_code', 'sentry_read_code', 'sentry_query_mq']) {
  if (root.tools.get(name) === undefined) {
    throw new Error(`FAIL: tool "${name}" was not registered`)
  }
}

const assembly = await root.systemPrompt.assemble()
if (!assembly.sections.some(section => section.name === 'sentry-persona')) {
  throw new Error('FAIL: persona section missing from assembled system prompt')
}

const skills = await root.skills.list()
for (const expected of ['log-analyzer', 'defect-troubleshooting', 'cross-service-latency', 'incident-templates', 'project-context', 'code-repository', 'mq-inspector', 'trace-analyzer', 'metrics-inspector', 'db-inspector', 'redis-inspector', 'zadig-inspector']) {
  if (!skills.some(skill => skill.name === expected)) {
    throw new Error(`FAIL: skill "${expected}" was not registered`)
  }
}

console.log('Phase 0 OK')
console.log('tools:', ['sentry_query_logs', 'sentry_list_log_services', 'sentry_fetch_trace', 'sentry_query_metrics', 'sentry_list_metrics', 'sentry_list_alerts', 'sentry_query_db', 'sentry_query_redis', 'sentry_query_zadig', 'sentry_search_code', 'sentry_read_code', 'sentry_query_mq'].join(', '))
console.log('skills:', skills.map(skill => skill.name).join(', '))

await root.fiber.dispose()
