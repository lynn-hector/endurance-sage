#!/usr/bin/env node
/**
 * Phase 0 loader-path verification.
 *
 * Boots the declarative `../cordis.yml` composition through the Cordis loader
 * (same mechanism as the `cordis` CLI), waits for the probe plugin to come
 * online, asserts both registrations, then disposes the tree.
 */

import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const appDir = new URL('..', import.meta.url)
const ctx = new Context()
ctx.baseUrl = pathToFileURL(appDir.pathname).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: './cordis.yml' },
})

const deadline = Date.now() + 10_000
let ready = false
while (Date.now() < deadline) {
  const tools = ctx.get('tools')
  ready = tools?.get('sentry_hello') !== undefined
    && tools.get('sentry_query_logs') !== undefined
    && tools.get('sentry_list_log_services') !== undefined
    && tools.get('sentry_fetch_trace') !== undefined
    && tools.get('sentry_query_metrics') !== undefined
    && tools.get('sentry_list_alerts') !== undefined
    && tools.get('sentry_query_db') !== undefined
    && tools.get('sentry_query_redis') !== undefined
    && tools.get('sentry_query_zadig') !== undefined
  if (ready) break
  await new Promise(resolve => setTimeout(resolve, 100))
}
if (!ready) {
  throw new Error('FAIL: probe/log tools were not all registered via cordis.yml')
}

const skills = await ctx.skills.list()
for (const expected of ['sentry-hello', 'log-analyzer']) {
  if (!skills.some(skill => skill.name === expected)) {
    throw new Error(`FAIL: skill "${expected}" was not registered via cordis.yml`)
  }
}

console.log('Phase 0 loader OK')
console.log('skills:', skills.map(skill => skill.name).join(', '))

await ctx.fiber.dispose()
