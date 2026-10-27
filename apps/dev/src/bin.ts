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
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CodeRepositoryService from '@dsh-sentry/service-code-repository'
import { SessionEnvBindingStore } from '@dsh-sentry/env-binding'
import SessionEnvProviders from '@dsh-sentry/service-env-provider'
import * as dbInspector from '@dsh-sentry/tool-db-inspector'
import * as logAnalyzer from '@dsh-sentry/tool-log-analyzer'
import * as callflowAnalyzer from '@dsh-sentry/tool-callflow-analyzer'
import * as metricsInspector from '@dsh-sentry/tool-metrics-inspector'
import * as redisInspector from '@dsh-sentry/tool-redis-inspector'
import * as sentryPersona from '@dsh-sentry/sentry-persona'
import * as sentrySkills from '@dsh-sentry/sentry-skills'
import * as traceAnalyzer from '@dsh-sentry/tool-trace-analyzer'
import * as zadigInspector from '@dsh-sentry/tool-zadig-inspector'
import * as codeRepository from '@dsh-sentry/tool-code-repository'
import * as mqInspector from '@dsh-sentry/tool-mq-inspector'

const root = new Context()

await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)
await root.plugin(SkillRegistry)
// Session 环境栈：绑定存储 + Provider 池。证据 Provider 不再全局装配，
// 由池按各 Session 绑定从 envs.yml（defaultEnvsPath）懒创建。
await root.plugin(SessionStore)
await root.plugin(SessionProjectionRegistry)
await root.plugin(SessionEnvBindingStore, { defaultEnv: 'dev-platform-hosted-0' })
await root.plugin(SessionEnvProviders)
await root.plugin(logAnalyzer)
await root.plugin(callflowAnalyzer)
await root.plugin(traceAnalyzer)
await root.plugin(metricsInspector)
await root.plugin(dbInspector, { database: 'novo_commctl_config' })
await root.plugin(redisInspector)
await root.plugin(zadigInspector)
await root.plugin(mqInspector)
await root.plugin(CodeRepositoryService, { baseDir: '/tmp/sentry-code-repos' })
await root.plugin(codeRepository, { env: 'local' })
await root.plugin(sentrySkills)
await root.plugin(sentryPersona)

const TOOLS = ['sentry_query_logs', 'sentry_list_log_services', 'sentry_query_call_flow', 'sentry_fetch_trace', 'sentry_query_metrics', 'sentry_list_metrics', 'sentry_list_alerts', 'sentry_get_alert_rule', 'sentry_list_am_alerts', 'sentry_list_am_silences', 'sentry_query_db', 'sentry_query_redis', 'sentry_query_zadig', 'sentry_search_code', 'sentry_read_code', 'sentry_sync_code', 'sentry_query_mq']

for (const name of TOOLS) {
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
console.log('tools:', TOOLS.join(', '))
console.log('skills:', skills.map(skill => skill.name).join(', '))

await root.fiber.dispose()
