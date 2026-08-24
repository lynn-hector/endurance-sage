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
import GreptimeDbService from '@dsh-sentry/service-greptimedb'
import TraceService from '@dsh-sentry/service-trace'
import * as hello from '@dsh-sentry/tool-hello'
import * as logAnalyzer from '@dsh-sentry/tool-log-analyzer'
import * as traceAnalyzer from '@dsh-sentry/tool-trace-analyzer'

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

const tool = root.tools.get('sentry_hello')
if (tool === undefined) {
  throw new Error('FAIL: tool "sentry_hello" was not registered')
}

for (const name of ['sentry_query_logs', 'sentry_list_log_services', 'sentry_fetch_trace']) {
  if (root.tools.get(name) === undefined) {
    throw new Error(`FAIL: tool "${name}" was not registered`)
  }
}

const skills = await root.skills.list()
if (!skills.some(skill => skill.name === 'sentry-hello')) {
  throw new Error('FAIL: skill "sentry-hello" was not registered')
}

console.log('Phase 0 OK')
console.log('tool parameters:', JSON.stringify(tool.parameters))
console.log('tools:', ['sentry_hello', 'sentry_query_logs', 'sentry_list_log_services', 'sentry_fetch_trace'].join(', '))
console.log('skills:', skills.map(skill => skill.name).join(', '))

await root.fiber.dispose()
