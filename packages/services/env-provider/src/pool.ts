import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { CacheStore } from '@dsh-sentry/cache-store'
import type { CallflowStore } from '@dsh-sentry/callflow-store'
import type { DbStore } from '@dsh-sentry/db-store'
import { readMatrix, renderEntries, type EnvRow } from '@dsh-sentry/env-matrix'
import type { LogStore } from '@dsh-sentry/log-store'
import type { MetricsStore } from '@dsh-sentry/metrics-store'
import type { MqStore } from '@dsh-sentry/mq-store'
import type { TraceStore } from '@dsh-sentry/trace-store'
import DbxService from '@dsh-sentry/service-dbx'
import GreptimeDbService from '@dsh-sentry/service-greptimedb'
import TraceService from '@dsh-sentry/service-trace'
import PrometheusService from '@dsh-sentry/service-prometheus'
import AlertmanagerPlugin from '@dsh-sentry/service-alertmanager'
import type { AlertmanagerService as AlertmanagerProvider } from '@dsh-sentry/service-alertmanager'
import RocketMqService from '@dsh-sentry/service-rocketmq'
import ZadigService from '@dsh-sentry/service-zadig'
import type { ZadigService as ZadigProvider } from '@dsh-sentry/service-zadig'

/**
 * The per-environment Provider bundle one Tool call leases. Missing legs are
 * simply absent — the lease carries the reason in `unavailableLegs`, matching
 * the per-leg degradation contract (one broken backend never blocks the rest).
 */
export interface EnvProviderBundle {
  cacheStore?: CacheStore
  dbStore?: DbStore
  logStore?: LogStore
  callflowStore?: CallflowStore
  traceStore?: TraceStore
  metricsStore?: MetricsStore
  alertmanager?: AlertmanagerProvider
  mqStore?: MqStore
  zadig?: ZadigProvider
}

type BundleSlot = keyof EnvProviderBundle

export interface EnvProviderLease extends EnvProviderBundle {
  /** Canonical environment and Provider generation selected for this call. */
  readonly env: string
  /** Legs whose Provider could not be created for this environment. */
  readonly unavailableLegs: ReadonlyArray<{ leg: string; error: string }>
  /** Idempotent release; must run after both successful and failed calls. */
  readonly release: () => Promise<void>
  /** Fetch a required Provider or fail with the leg's unavailability reason. */
  require<S extends BundleSlot>(slot: S): NonNullable<EnvProviderBundle[S]>
}

interface ProviderEntry {
  readonly env: string
  readonly configVersion: string
  readonly ready: Promise<EntryResources>
  leases: number
  retired: boolean
  disposePromise?: Promise<void>
}

interface EntryResources {
  readonly bundle: EnvProviderBundle
  readonly unavailableLegs: Array<{ leg: string; error: string }>
  readonly fibers: Fiber[]
}

/** Every Cordis slot one environment's Providers register into. */
const ISOLATED_SLOTS: readonly BundleSlot[] = [
  'cacheStore',
  'dbStore',
  'logStore',
  'callflowStore',
  'traceStore',
  'metricsStore',
  'alertmanager',
  'mqStore',
  'zadig',
]

type ProviderPlugin =
  | typeof DbxService
  | typeof GreptimeDbService
  | typeof TraceService
  | typeof PrometheusService
  | typeof AlertmanagerPlugin
  | typeof RocketMqService
  | typeof ZadigService

/**
 * Per-leg Provider wiring. Configs come from `renderEntries()` — the same
 * single derivation the assembly files use — so a Session-routed Provider
 * can never drift from what a regenerated global assembly would load.
 */
const PROVIDER_SERVICES: ReadonlyArray<{
  readonly packageName: string
  readonly leg: string
  readonly plugin: ProviderPlugin
  readonly slots: readonly BundleSlot[]
}> = [
  { packageName: '@dsh-sentry/service-dbx', leg: 'dbx', plugin: DbxService, slots: ['cacheStore', 'dbStore'] },
  { packageName: '@dsh-sentry/service-greptimedb', leg: 'greptimedb', plugin: GreptimeDbService, slots: ['logStore', 'callflowStore'] },
  { packageName: '@dsh-sentry/service-trace', leg: 'trace', plugin: TraceService, slots: ['traceStore'] },
  { packageName: '@dsh-sentry/service-prometheus', leg: 'prometheus', plugin: PrometheusService, slots: ['metricsStore'] },
  { packageName: '@dsh-sentry/service-alertmanager', leg: 'alertmanager', plugin: AlertmanagerPlugin, slots: ['alertmanager'] },
  { packageName: '@dsh-sentry/service-rocketmq', leg: 'rocketmq', plugin: RocketMqService, slots: ['mqStore'] },
  { packageName: '@dsh-sentry/service-zadig', leg: 'zadig', plugin: ZadigService, slots: ['zadig'] },
]

function requireError(env: string, slot: BundleSlot, reason: string): Error {
  return new Error(`环境 ${env} 的 ${slot} Provider 不可用: ${reason}`)
}

/**
 * Owns per-environment Cordis fibers and their authentication/connection state.
 * Entries are reused until the environment's derived service config changes or
 * the pool is disposed. Retired generations drain their leases before
 * disposal. Legs that fail to start degrade individually — acquire succeeds as
 * long as the environment exists in the matrix.
 */
export class EnvProviderPool {
  private readonly latest = new Map<string, ProviderEntry>()
  private readonly entries = new Set<ProviderEntry>()
  private disposed = false
  private readonly ctx: Context
  private readonly config: { envsPath: string }

  constructor(ctx: Context, config: { envsPath: string }) {
    this.ctx = ctx
    this.config = config
  }

  async acquire(env: string): Promise<EnvProviderLease> {
    if (this.disposed) throw new Error('环境 Provider 池已释放')
    const row = readMatrix(this.config.envsPath)[env]
    if (row === undefined) throw new Error(`环境矩阵缺少已解析环境: ${env}`)
    const entry = this.entryFor(env, row)
    entry.leases++
    let resources: EntryResources
    try {
      resources = await entry.ready
    } catch (error) {
      entry.leases--
      await this.disposeIfDrained(entry)
      throw error
    }

    const legErrors = new Map(resources.unavailableLegs.map(item => [item.leg, item.error]))
    let released = false
    const bundle = resources.bundle
    const lease: EnvProviderLease = {
      env,
      ...bundle,
      unavailableLegs: resources.unavailableLegs,
      release: async () => {
        if (released) return
        released = true
        entry.leases--
        await this.disposeIfDrained(entry)
      },
      require: <S extends BundleSlot>(slot: S): NonNullable<EnvProviderBundle[S]> => {
        const instance = bundle[slot]
        if (instance === undefined) {
          throw requireError(env, slot, legErrors.get(legOfSlot(slot)) ?? '未加载')
        }
        return instance as NonNullable<EnvProviderBundle[S]>
      },
    }
    return lease
  }

  /** Dispose every generation; runtime shutdown does not wait for active calls. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.latest.clear()
    const entries = [...this.entries]
    for (const entry of entries) entry.retired = true
    await Promise.all(entries.map(async entry => {
      entry.leases = 0
      await this.disposeIfDrained(entry)
    }))
  }

  private entryFor(env: string, row: EnvRow): ProviderEntry {
    const configVersion = this.deriveConfigVersion(row)
    const current = this.latest.get(env)
    if (current !== undefined && current.configVersion === configVersion && !current.retired) {
      return current
    }
    if (current !== undefined) this.retire(current)

    const entry: ProviderEntry = {
      env,
      configVersion,
      ready: this.create(env, row),
      leases: 0,
      retired: false,
    }
    this.latest.set(env, entry)
    this.entries.add(entry)
    void entry.ready.catch(() => {
      entry.retired = true
      if (this.latest.get(env) === entry) this.latest.delete(env)
    })
    return entry
  }

  /** Version bumps whenever any Provider leg's derived config changes. */
  private deriveConfigVersion(row: EnvRow): string {
    const rendered = renderEntries(row)
    return JSON.stringify(PROVIDER_SERVICES.map(spec =>
      rendered.find(entry => entry.name === spec.packageName)?.config ?? null,
    ))
  }

  private async create(env: string, row: EnvRow): Promise<EntryResources> {
    // Each named service needs its own isolation label: Cordis keys provider
    // registrations by label, so sharing one label across names would collide.
    // Unlisted services (notably credentials) still inherit from the root.
    let envCtx: Context = this.ctx
    for (const slot of ISOLATED_SLOTS) {
      envCtx = envCtx.isolate(slot, Symbol(`dsh-sentry-env:${env}:${slot}`))
    }

    const rendered = renderEntries(row)
    const fibers: Fiber[] = []
    const bundle: EnvProviderBundle = {}
    const unavailableLegs: Array<{ leg: string; error: string }> = []
    for (const spec of PROVIDER_SERVICES) {
      const config = rendered.find(entry => entry.name === spec.packageName)?.config
      if (config === undefined) {
        unavailableLegs.push({ leg: spec.leg, error: `环境矩阵未渲染 ${spec.packageName} 的插件配置` })
        continue
      }
      try {
        fibers.push(await envCtx.plugin(spec.plugin, config))
        for (const slot of spec.slots) {
          const instance = envCtx.get(slot)
          if (instance === undefined) {
            unavailableLegs.push({ leg: spec.leg, error: `${spec.packageName} 已加载但 ${slot} 插槽不可用` })
            continue
          }
          ;(bundle as Record<BundleSlot, unknown>)[slot] = instance
        }
      } catch (cause) {
        unavailableLegs.push({ leg: spec.leg, error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    return { bundle, unavailableLegs, fibers }
  }

  private retire(entry: ProviderEntry): void {
    entry.retired = true
    if (this.latest.get(entry.env) === entry) this.latest.delete(entry.env)
    void this.disposeIfDrained(entry)
  }

  private async disposeIfDrained(entry: ProviderEntry): Promise<void> {
    if (!entry.retired || entry.leases > 0 || this.entries.has(entry) === false) return
    entry.disposePromise ??= (async () => {
      try {
        const resources = await entry.ready
        for (const fiber of resources.fibers) await fiber.dispose()
      } catch {
        // Failed or already-disposed plugin startup has no resource to release.
      } finally {
        this.entries.delete(entry)
      }
    })()
    await entry.disposePromise
  }
}

function legOfSlot(slot: BundleSlot): string {
  const spec = PROVIDER_SERVICES.find(item => item.slots.includes(slot))
  return spec?.leg ?? slot
}
