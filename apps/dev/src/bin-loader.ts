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
let tool: unknown
while (Date.now() < deadline) {
  tool = ctx.get('tools')?.get('sentry_hello')
  if (tool !== undefined) break
  await new Promise(resolve => setTimeout(resolve, 100))
}
if (tool === undefined) {
  throw new Error('FAIL: tool "sentry_hello" was not registered via cordis.yml')
}

const skills = await ctx.skills.list()
if (!skills.some(skill => skill.name === 'sentry-hello')) {
  throw new Error('FAIL: skill "sentry-hello" was not registered via cordis.yml')
}

console.log('Phase 0 loader OK')
console.log('skills:', skills.map(skill => skill.name).join(', '))

await ctx.fiber.dispose()
