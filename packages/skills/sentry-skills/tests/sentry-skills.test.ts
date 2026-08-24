import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as sentrySkills from '../src/index.ts'

/**
 * Verifies every bundled skill registers with non-empty adapted content.
 * Content-level golden pinning (specific sections per skill) lives in the
 * per-skill blocks below.
 */

async function bootSkills(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(sentrySkills)
  return ctx
}

describe('sentry-skills registration', () => {
  it('registers every bundled skill', async () => {
    const ctx = await bootSkills()
    const skills = await ctx.skills.list()
    const names = skills.map(skill => skill.name)
    expect(names).toContain('log-analyzer')
    const full = await ctx.skills.get('log-analyzer')
    expect(full?.content.length).toBeGreaterThan(1000)
    await ctx.fiber.dispose()
  })
})

describe('log-analyzer skill content', () => {
  it('describes DSH tools, not the python CLI', async () => {
    const ctx = await bootSkills()
    const content = (await ctx.skills.get('log-analyzer'))?.content ?? ''
    // Adapted: tool names in, CLI invocation out.
    expect(content).toContain('sentry_query_logs')
    expect(content).toContain('sentry_list_log_services')
    expect(content).not.toContain('python3')
    expect(content).not.toContain('--list-services')
    // The DSL syntax and the field whitelist survive.
    expect(content).toContain('field LIKE value')
    expect(content).toContain('`workload_name`')
    // The documented drift fix: SQL order matches the implementation.
    const orderIdx = [
      content.indexOf('"log_type" = \'...\''),
      content.indexOf('"greptime_timestamp" >= \'...\''),
      content.indexOf('"workload_name"'),
    ]
    expect(orderIdx[0]).toBeGreaterThan(0)
    expect(orderIdx[0]).toBeLessThan(orderIdx[1]!)
    expect(orderIdx[1]).toBeLessThan(orderIdx[2]!)
    await ctx.fiber.dispose()
  })
})
