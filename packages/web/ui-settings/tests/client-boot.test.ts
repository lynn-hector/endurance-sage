import { describe, expect, it, vi } from 'vitest'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { apply, inject } from '../client/index.tsx'
import type { SectionServices } from '../client/section.tsx'
import type { ClientContext } from '../client/types.ts'

interface ChildPlugin {
  inject: string[]
  apply(ctx: ClientContext): void | Promise<void>
}

type SectionComponent = (props: { close: () => void }) => {
  props: { services: SectionServices }
}

describe('ui-settings client boot', () => {
  it('mounts sentrySettings before a child plugin injects and calls it', async () => {
    const disposeRemote = vi.fn(async () => {})
    let childMayReadSettings = false
    const defaultEnv = { effectiveEnv: 'dev-platform-hosted-0', assemblyEnv: 'tst-platform-hosted-0' }
    const remote: Record<string, unknown> = {
      credentials: {},
      $on: vi.fn(() => () => {}),
    }
    const mount = vi.fn(async (_contribution: TypertRemoteContribution) => {
      Object.defineProperty(remote, 'sentrySettings', {
        configurable: true,
        get: () => {
          if (!childMayReadSettings) {
            throw new Error('cannot get property "remote.sentrySettings" without inject')
          }
          return { getDefaultEnv: async () => ({ ok: true, value: defaultEnv }) }
        },
      })
      return disposeRemote
    })
    remote.$mount = mount
    let section: SectionComponent | undefined
    const register = vi.fn((_options: unknown, component: SectionComponent) => { section = component })
    const plugin = vi.fn(async (child: ChildPlugin) => {
      expect(child.inject).toContain('remote.sentrySettings')
      childMayReadSettings = true
      await child.apply(ctx)
    })
    const ctx = {
      remote,
      plugin,
      slots: {
        inject: (_slot: string, callback: () => unknown) => callback(),
        register,
      },
      on: vi.fn(),
    } as unknown as ClientContext

    const missing = inject.filter(key => key.startsWith('remote.')
      && !(key.slice('remote.'.length) in remote))
    expect(missing).toEqual([])

    const dispose = await apply(ctx)
    expect(mount).toHaveBeenCalledOnce()
    expect(mount.mock.calls[0]?.[0].package).toBe('@dsh-sentry/ui-settings')
    expect(plugin).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()

    const rendered = section!({ close: vi.fn() })
    await expect(rendered.props.services.remote.getDefaultEnv()).resolves.toEqual({ ok: true, value: defaultEnv })
    await dispose?.()
    expect(disposeRemote).toHaveBeenCalledOnce()
  })
})
