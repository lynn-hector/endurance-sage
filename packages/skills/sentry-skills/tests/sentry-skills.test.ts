import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as sentrySkills from '../src/index.ts'

/**
 * Native-bundle gate for the sentry skills: the filesystem provider must
 * discover the complete 16-skill catalog from `../skills/<name>/SKILL.md`,
 * strip frontmatter from loaded bodies, and own them as `sentry-bundled`
 * contributions. Content-level golden pinning lives in the per-skill blocks
 * below.
 */

const BUNDLE_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** The complete domain catalog, sorted as `ctx.skills.list()` returns it. */
const SKILL_NAMES = [
  'alert-analysis',
  'callflow-analyzer',
  'code-repository',
  'cross-service-latency',
  'db-inspector',
  'defect-troubleshooting',
  'env-switcher',
  'incident-templates',
  'log-analyzer',
  'metrics-inspector',
  'mq-inspector',
  'project-context',
  'redis-inspector',
  'tapd-inspector',
  'trace-analyzer',
  'zadig-inspector',
]

async function bootSkills(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(sentrySkills)
  return ctx
}

describe('sentry-skills native bundle', () => {
  it('discovers exactly the full 16-skill catalog', async () => {
    const ctx = await bootSkills()
    const names = (await ctx.skills.list()).map(skill => skill.name)
    expect(names).toEqual(SKILL_NAMES)
    await ctx.fiber.dispose()
  })

  it('loads every skill as a frontmatter-free bundled body', async () => {
    const ctx = await bootSkills()
    for (const name of SKILL_NAMES) {
      const skill = await ctx.skills.get(name)
      expect(skill, name).toBeDefined()
      expect(skill!.provider, name).toBe('sentry-bundled')
      expect(skill!.source, name).toBe('bundled')
      expect(skill!.description, name).toBeTruthy()
      expect(skill!.content.length, name).toBeGreaterThan(100)
      expect(skill!.content.startsWith('---'), name).toBe(false)
      expect(skill!.path, name).toBe(resolve(BUNDLE_DIR, name, 'SKILL.md'))
      expect(skill!.resourceBase?.kind, name).toBe('directory')
      expect(skill!.resourceBase?.kind === 'directory' && skill!.resourceBase.path, name)
        .toBe(resolve(BUNDLE_DIR, name))
    }
    await ctx.fiber.dispose()
  })

  it('mounts nothing without the bundle plugin (no cross-context leakage)', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    expect(await ctx.skills.list()).toEqual([])
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
    expect(orderIdx[1]!).toBeLessThan(orderIdx[2]!)
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

describe('callflow-analyzer skill content', () => {
  it('describes the hep_1 call-flow tool', async () => {
    const ctx = await bootSkills()
    const content = (await ctx.skills.get('callflow-analyzer'))?.content ?? ''
    expect(content).toContain('sentry_query_call_flow')
    expect(content).toContain('hep_1')
    expect(content).toContain('call_id')
    expect(content).toContain('trace_ids')
    await ctx.fiber.dispose()
  })
})

describe('tapd-inspector skill content', () => {
  it('ships the previously unlisted tapd skill in the catalog', async () => {
    const ctx = await bootSkills()
    const skill = await ctx.skills.get('tapd-inspector')
    expect(skill).toBeDefined()
    expect(skill!.content).toContain('sentry_query_tapd')
    expect(skill!.description).toContain('TAPD 缺陷单')
    await ctx.fiber.dispose()
  })
})
