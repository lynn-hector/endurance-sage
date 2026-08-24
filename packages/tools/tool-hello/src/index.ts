/**
 * Phase 0 verification plugin.
 *
 * Proves the two registration paths dsh-sentry relies on:
 * - `ctx.tools.register(defineTool(...))` — model-facing agent tools (replaces CLI scripts).
 * - `ctx.skills.register(...)` — model-loadable instruction bodies (replaces SKILL.md sync).
 *
 * This package is throwaway scaffolding; real plugins live under
 * `packages/services` and `packages/tools` once Phase 1+ starts.
 *
 * @module @dsh-sentry/tool-hello
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sentry-hello'

/** The seams this plugin registers into. */
export const inject = ['tools', 'skills']

/** Plugin config; validated and defaulted by the schema below. */
export interface Config {
  /** Greeting returned by the `sentry_hello` tool. */
  greeting?: string
}

export const Config: z<Config> = z.object({
  greeting: z.string().default('hello from dsh-sentry'),
})

/** Register one probe tool and one probe skill. */
export function apply(ctx: Context, config: Config): void {
  ctx.skills.register({
    name: 'sentry-hello',
    description: 'Phase 0 probe skill; verifies ctx.skills registration for external plugins.',
    source: 'bundled',
    content: '# sentry-hello\n\nPhase 0 验证用 skill。如果你看到这段内容，说明 dsh-sentry 的 skill 注册链路已经打通。',
  })

  ctx.tools.register(defineTool({
    name: 'sentry_hello',
    description: 'Phase 0 probe tool. Echoes the configured greeting plus the given subject.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Who to greet.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute(args, _exec) {
      return Promise.resolve({ message: `${config.greeting ?? 'hello from dsh-sentry'}: ${args.subject}` })
    },
  }))
}
