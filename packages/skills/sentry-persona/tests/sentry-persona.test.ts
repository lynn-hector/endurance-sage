import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as persona from '../src/index.ts'

/**
 * Verifies the persona lands in the assembled system prompt as one section
 * right after the harness identity, carrying the constitution's key lines.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sentry-persona', () => {
  it('registers a persona section with the constitution content', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(persona)

    const assembly = await ctx.systemPrompt.assemble()
    const ours = assembly.sections.find(section => section.name === 'sentry-persona')
    expect(ours).toBeDefined()

    const text = assembly.sections.map(section => section.text).join('\n')
    expect(text).toContain('故障调查员行为宪法')
    expect(text).toContain('证据先于结论')
    expect(text).toContain('rollback_plan')
    // Adapted for DSH: no repo file references from the script era.
    expect(text).not.toContain('docs/methodology')
    expect(text).not.toContain('templates/')

    await ctx.fiber.dispose()
  })
})
