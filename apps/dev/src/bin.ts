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
import * as hello from '@dsh-sentry/tool-hello'

const root = new Context()

await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime)
await root.plugin(SkillRegistry)
await root.plugin(hello)

const tool = root.tools.get('sentry_hello')
if (tool === undefined) {
  throw new Error('FAIL: tool "sentry_hello" was not registered')
}

const skills = await root.skills.list()
if (!skills.some(skill => skill.name === 'sentry-hello')) {
  throw new Error('FAIL: skill "sentry-hello" was not registered')
}

console.log('Phase 0 OK')
console.log('tool parameters:', JSON.stringify(tool.parameters))
console.log('skills:', skills.map(skill => skill.name).join(', '))

await root.fiber.dispose()
