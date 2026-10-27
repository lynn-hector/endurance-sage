/**
 * Methodology skills for the sentry plugins.
 *
 * Ports the original project's instruction layer — one skill per original
 * `skills/<name>/` directory, merging its `SKILL.md`, `prompts/usage.md`
 * and (when present) `methodology.md` into a single model-loadable body.
 * The content is adapted, not copied verbatim:
 * - Claude-Code frontmatter and `python3` CLI examples are gone; the bodies
 *   describe the DSH tools (`sentry_query_logs` etc.) instead;
 * - `--env` disappeared as a parameter — the environment follows the
 *   calling session's binding and survives only as evidence metadata;
 * - comma-separated CLI strings became JSON arrays in the parameter tables;
 * - documented drift between the original SKILL.md and the scripts (e.g. the
 *   SQL clause order) is fixed in favor of the actual tool behavior.
 *
 * Skill bodies live in `../skills/<name>/SKILL.md` and are discovered by the
 * native DSH filesystem provider: YAML frontmatter (`name`, `description`)
 * is the single metadata source — there is no hand-maintained manifest —
 * and `watch: true` reloads edits without a code change.
 *
 * @module @dsh-sentry/sentry-skills
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import * as FileSystemSkills from '@deepseek-ai/dsh-skill-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sentry-skills'

/** The seams this plugin registers into. */
export const inject = ['skills']

/**
 * Mount the native filesystem provider over the bundled skill directory.
 *
 * `includeDefaultRoots: false` keeps discovery inside this bundle (host
 * project/user roots stay to the host's own provider); the unique
 * `providerName` avoids registry conflicts; context disposal releases the
 * directory watchers with the provider.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FileSystemSkills, {
    providerName: 'sentry-bundled',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
    watch: true,
  })
}
