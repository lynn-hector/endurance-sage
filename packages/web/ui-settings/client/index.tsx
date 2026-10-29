/**
 * Browser half of `@dsh-sentry/ui-settings` (served as the package's
 * `./client` bundle by the DSH client module system).
 *
 * Registers one `settings.section` entry (id `sentry-env-credentials`) in the
 * settings shell: the default environment preference, global machine config,
 * environment readiness, and per-source configuration details. Secret values
 * stay write-only behind the credentials seam; the non-secret default
 * environment and code base use the package's narrow sentrySettings Remote.
 *
 * @module @dsh-sentry/ui-settings/client
 */

import { createSection } from './section.tsx'
import { sentrySettingsRemote } from './remote.ts'
import type { ClientContext, ClientPlugin } from './types.ts'

/** Only the base Remote service is needed by the mounting parent. */
export const inject = ['remote']

/** The child declares the mounted namespace so Cordis permits every read. */
const sectionPlugin: ClientPlugin = {
  name: 'sentry-ui-settings-section',
  inject: ['slots', 'remote.credentials', 'remote.sentrySettings'],
  apply(ctx) {
    const services = {
      remote: {
        describe: (refs: string[]) => ctx.remote.credentials.describe(refs),
        set: (ref: string, value: string) => ctx.remote.credentials.set(ref, value),
        unset: (ref: string) => ctx.remote.credentials.unset(ref),
        getDefaultEnv: () => ctx.remote.sentrySettings.getDefaultEnv(),
        getGlobalConfig: () => ctx.remote.sentrySettings.getGlobalConfig(),
      },
      subscribe: (invalidate: () => void) => {
        const disposers = [
          ctx.remote.$on('credentials/reference-updated', invalidate),
          ctx.remote.$on('credentials/record-updated', invalidate),
          ctx.on('connection/reset', invalidate),
        ]
        return () => { for (const dispose of disposers) dispose() }
      },
    }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'sentry-env-credentials',
      order: 15,
      label: () => '环境与凭据',
    }, createSection(services)))
  },
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const dispose = await ctx.remote.$mount(sentrySettingsRemote)
  try {
    await ctx.plugin(sectionPlugin)
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}
