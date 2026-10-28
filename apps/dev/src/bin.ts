#!/usr/bin/env node
/**
 * Programmatic host for the same aggregate bundle consumed from npm.
 * The declarative equivalent lives in ../cordis.yml.
 */

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as sentry from '@dsh-sentry/sentry'

const root = new Context()
await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)
await root.plugin(SkillRegistry)
await root.plugin(SessionStore)
await root.plugin(SessionProjectionRegistry)
await root.plugin(sentry, { defaultEnv: 'dev-platform-hosted-0' })

const TOOLS = ['sentry_query_logs', 'sentry_list_log_services', 'sentry_query_call_flow', 'sentry_fetch_trace', 'sentry_query_metrics', 'sentry_list_metrics', 'sentry_list_alerts', 'sentry_get_alert_rule', 'sentry_list_am_alerts', 'sentry_list_am_silences', 'sentry_query_db', 'sentry_query_redis', 'sentry_query_zadig', 'sentry_search_code', 'sentry_read_code', 'sentry_sync_code', 'sentry_query_mq']
for (const name of TOOLS) {
  if (root.tools.get(name) === undefined) throw new Error(`FAIL: tool "${name}" was not registered`)
}

const assembly = await root.systemPrompt.assemble()
if (!assembly.sections.some(section => section.name === 'sentry-persona')) {
  throw new Error('FAIL: persona section missing from assembled system prompt')
}

const skills = await root.skills.list()
for (const expected of ['log-analyzer', 'defect-troubleshooting', 'cross-service-latency', 'incident-templates', 'project-context', 'code-repository', 'mq-inspector', 'trace-analyzer', 'metrics-inspector', 'db-inspector', 'redis-inspector', 'zadig-inspector']) {
  if (!skills.some(skill => skill.name === expected)) throw new Error(`FAIL: skill "${expected}" was not registered`)
}

console.log('Aggregate bundle OK')
console.log('tools:', TOOLS.join(', '))
console.log('skills:', skills.map(skill => skill.name).join(', '))
await root.fiber.dispose()
