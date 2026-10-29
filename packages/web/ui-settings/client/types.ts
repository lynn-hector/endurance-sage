/**
 * Minimal typing for the DSH client faces this page consumes.
 *
 * Vendored on purpose instead of depending on the upstream type packages:
 * the host is a developer preview with breaking changes, and the surface used
 * here is the stable contract shared by every first-party settings plugin
 * (`ctx.slots.inject/register`, `ctx.remote.credentials`, `ctx.remote.$on`).
 * If the host API drifts, this thin file is the only place to update.
 */

import type { TypertDisposer, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

export interface SettingsSectionOwnerProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}

export interface SlotRegisterOptions {
  name: string
  /** list-slot entry key; drives `only` filtering. */
  id?: string
  /** nav position among sections. */
  order?: number
  /** registrant-localized display text. */
  label?: () => string
  /** services that must be live before the entry activates. */
  inject?: string[]
}

export interface SlotsFace {
  /** Run `register` once the named slot declaration is on the ledger. */
  inject(slot: string, register: () => unknown): unknown
  /** Register one entry into a declared slot; `component` renders its content. */
  register(options: SlotRegisterOptions, component: unknown): unknown
}

/** Mirrors `CredentialInfo` from `@deepseek-ai/dsh-credentials` — never the value. */
export interface DefaultEnvInfo {
  preference?: string
  effectiveEnv: string
  assemblyEnv: string
}

/** Non-secret machine-global configuration read by the host settings service. */
export interface GlobalConfigInfo {
  /** Effective code-search base dir (env var > credential store); absent when unset. */
  codeBaseDir?: string
}

export interface CredentialInfo {
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  writable: boolean
}

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

export interface CredentialsRemoteFace {
  /** Batched presence/writability facts; at most 64 refs per call. */
  describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>
  set(ref: string, value: string): Promise<RemoteResult<void>>
  unset(ref: string): Promise<RemoteResult<void>>
}

export interface SettingsRemoteFace {
  /** Read the non-secret machine preference and effective/assembly defaults. */
  getDefaultEnv(): Promise<RemoteResult<DefaultEnvInfo>>
  /** Read non-secret machine-global values (currently the code-search base dir). */
  getGlobalConfig(): Promise<RemoteResult<GlobalConfigInfo>>
}

export interface RemoteFace {
  credentials: CredentialsRemoteFace
  sentrySettings: SettingsRemoteFace
  /** Mount this package's host Remote before consuming its namespace. */
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  /** Subscribe to host-pushed invalidation events; returns an disposer. */
  $on(event: string, listener: () => void): () => void
}

export interface ClientPlugin {
  name?: string
  inject: string[]
  apply(ctx: ClientContext): void | Promise<void>
}

export interface ClientContext {
  plugin(plugin: ClientPlugin): unknown
  slots: SlotsFace
  remote: RemoteFace
  on(event: 'connection/reset', listener: () => void): () => void
}
