/**
 * Always-on investigator persona for the sentry deployment.
 *
 * Port of the original `AGENTS.md` 行为宪法: the philosophy, safety rails,
 * and communication style that every turn runs under. In the script era
 * this file was read by the coding agent at repo root; here it becomes a
 * system-prompt section registered right after the harness identity.
 *
 * Adaptations (module-doc recorded):
 * - the 项目代码概览 tables moved into the `project-context` skill — the
 *   always-on prompt stays lean and the reference material loads on demand;
 * - file-path references (`templates/`, `docs/methodology/`) became skill
 *   names (incident-templates, defect-troubleshooting, …);
 * - 数据边界 rewritten for the credential plane: secrets live in the
 *   harness credential store, never in the repository or conversation.
 *
 * @module @dsh-sentry/sentry-persona
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sentry-persona'

/** The seams this plugin registers into. */
export const inject = ['systemPrompt']

/**
 * Section order: `0` is the deployment persona slot (harness identity sits
 * at `-100`); this persona lands at `10`, before tool guidance (100+).
 */
const SECTION_ORDER = 10

/** Register the persona section. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'sentry-persona',
    order: SECTION_ORDER,
    text: readFileSync(new URL('./persona.md', import.meta.url), 'utf8'),
  })
}
