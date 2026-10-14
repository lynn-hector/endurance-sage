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
    for (const expected of [
      'log-analyzer',
      'trace-analyzer',
      'metrics-inspector',
      'db-inspector',
      'redis-inspector',
      'zadig-inspector',
      'alert-analysis',
    ]) {
      expect(names).toContain(expected)
      const full = await ctx.skills.get(expected)
      expect(full?.content.length).toBeGreaterThan(1000)
    }
    await ctx.fiber.dispose()
  })

  it('no bundled body mentions the python CLI era', async () => {
    const ctx = await bootSkills()
    for (const skill of await ctx.skills.list()) {
      if (!skill.name.endsWith('-analyzer') && !skill.name.endsWith('-inspector')) continue
      const content = (await ctx.skills.get(skill.name))?.content ?? ''
      expect(content, skill.name).not.toContain('python3')
      expect(content, skill.name).not.toContain('--env')
    }
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

describe('alert-analysis skill content anchors', () => {
  it('pins the alert-analysis workflow anchors', async () => {
    const ctx = await bootSkills()
    const full = await ctx.skills.get('alert-analysis')
    const content = full?.content ?? ''
    for (const anchor of [
      'sentry_env_switch',
      'sentry_list_am_alerts',
      'sentry_get_alert_rule',
      'sentry_query_metrics',
      'sentry_query_logs',
      'sentry_query_zadig',
      'UTC+8',
      'commctl-config',
    ]) {
      expect(content).toContain(anchor)
    }
    await ctx.fiber.dispose()
  })
})
