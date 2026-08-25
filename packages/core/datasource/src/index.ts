/**
 * Shared configuration surface for dsh-sentry datasource plugins.
 *
 * This package is what remains of the original `skills/lib/config.py` after
 * its four responsibilities moved to native DSH mechanisms: parsing is the
 * loader's job, environments
 * are cordis.patch.yml layers, user overrides are dsh-settings sections, and
 * secrets are dsh-credentials references. What is left is the vocabulary every
 * datasource plugin's `Config` shares — endpoint, timeout, credential refs —
 * plus one bridge that resolves a credential reference against the ambient
 * credential plane.
 *
 * @module @dsh-sentry/datasource
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials/types'
import z from '@deepseek-ai/schemastery'

/** Default per-request timeout for datasource clients, matching the original `timeouts.default`. */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * HTTP/base endpoint field, e.g. `https://greptimedb.example.com`.
 * Required (schemastery object properties are optional unless marked): an
 * endpoint is exactly what differs per environment, so a schema-carried
 * default would read as a configured value in settings UIs.
 */
export function endpointField(description: string) {
  return z.string().required().description(description)
}

/** Per-request timeout in milliseconds. */
export function timeoutMsField(defaultMs: number = DEFAULT_TIMEOUT_MS) {
  return z.number().step(1).min(1).default(defaultMs)
    .description('单次请求超时（毫秒）')
}

/**
 * Credential *reference* field (a POSIX-style name such as
 * `GREPTIMEDB_PRODUCTION_USERNAME`), resolved through the credentials plane at
 * each operation. Optional by default — several datasources allow anonymous
 * access (e.g. a local Prometheus); chain `.required()` where the datasource
 * mandates the credential. Never a literal secret — literal secrets belong to
 * fields built with {@link secretField}, and even those are discouraged in
 * composition files.
 */
export function credentialRefField(description: string) {
  return z.string().role('credential-ref').description(description)
}

/**
 * Literal secret field. Prefer {@link credentialRefField} in composition
 * files; this exists for symmetric configs (e.g. a token a settings UI must
 * accept inline) and renders masked in configuration surfaces.
 */
export function secretField(description: string) {
  return z.string().role('secret').description(description)
}

/**
 * Resolve a credential reference to its current value.
 *
 * Resolution order mirrors the original environment-variable injection while
 * preferring the credentials plane when one is mounted:
 * 1. `ctx.credentials` (e.g. `$DSH_HOME/.credentials.yaml` over the process
 *    environment, hot-reloaded), when the seam is available;
 * 2. the process environment directly.
 *
 * Callers re-resolve at each operation and must not cache the value across
 * `credentials/updated` boundaries.
 * @param ctx - plugin context; the credentials seam is optional by design.
 * @param ref - reference name, e.g. `GREPTIMEDB_PRODUCTION_USERNAME`.
 * @returns the secret value, or `undefined` when the reference is unset everywhere.
 */
export async function resolveCredential(ctx: Context, ref: string): Promise<string | undefined> {
  // Validate upfront: the reference grammar holds with or without the seam.
  const reference = credentialRef(ref)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(reference)
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}
