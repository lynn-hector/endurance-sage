import { Context, Service } from '@deepseek-ai/cordis'
import {
  appendPluginRecord,
  Session,
} from '@deepseek-ai/dsh-session'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  credentialReadiness,
  credentialStorePath as defaultCredentialStorePath,
  defaultEnvsPath,
  readMatrix,
  resolveEnvName,
  type EnvRow,
  type LegReadiness,
  type Matrix,
} from '@dsh-sentry/env-matrix'
import {
  ENV_BINDING_PROJECTION_KEY,
  envBindingProjection,
} from './projection.ts'
import {
  ENV_BINDING_RECORD_TYPE,
  type EnvBindingRecord,
  type EnvBindingSource,
} from './record.ts'

type DshSessionModule = typeof import('@deepseek-ai/dsh-session')

/**
 * `appendPluginRecord` 经 `Session` 的私有方法提交，私有 brand 只属于创建该实例的
 * 那一份 dsh-session 模块。同一版本在 pnpm 下会按 peer 组合拆成多个副本
 * （`.pnpm/@deepseek-ai+dsh-session@<version>_<peer-hash>`），宿主 profile、
 * 插件自身、CLI 全局包拿到的可能各不相同。这里枚举候选副本并用
 * `instanceof Session` 验证同源，验证通过才提交，绝不盲试。
 */
function packageEntryUrl(pkgDirUrl: URL): URL | undefined {
  try {
    const manifest = JSON.parse(readFileSync(new URL('package.json', pkgDirUrl), 'utf8')) as {
      exports?: Record<string, { default?: string } | string>
      main?: string
    }
    const dot = manifest.exports?.['.'] as { default?: string } | string | undefined
    const entry = typeof dot === 'string' ? dot : dot?.default ?? manifest.main
    if (typeof entry !== 'string') return undefined
    return new URL(entry.replace(/^\.\//, ''), pkgDirUrl)
  } catch {
    return undefined
  }
}

/** 沿目录向上找到 pnpm 虚拟 store，列出该包的全部副本目录。 */
function pnpmPackageCopies(selfUrl: URL, storeName: string): URL[] {
  const dirs: URL[] = []
  let dir = new URL('.', selfUrl)
  for (let depth = 0; depth < 16; depth++) {
    const pnpmDir = new URL('node_modules/.pnpm/', dir)
    if (existsSync(pnpmDir)) {
      try {
        for (const entry of readdirSync(pnpmDir)) {
          if (!entry.startsWith(`${storeName}@`)) continue
          const pkgDir = new URL(`./${entry}/node_modules/${storeName}/`, pnpmDir)
          if (existsSync(new URL('package.json', pkgDir))) dirs.push(pkgDir)
        }
      } catch { /* 不可读则跳过 */ }
      if (dirs.length > 0) return dirs
    }
    const parent = new URL('..', dir)
    if (parent.href === dir.href) break
    dir = parent
  }
  return dirs
}

async function candidateModuleUrls(): Promise<string[]> {
  const urls: string[] = []
  const seen = new Set<string>()
  const push = (url: string | undefined): void => {
    if (url !== undefined && !seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  // 1) 宿主 CLI 入口所在依赖树。不用 import.meta.resolve：其 parent 参数在当前
  //    Node（v24.15 实测）被静默忽略，实际会从插件自身位置解析，永远拿不到宿主
  //    副本。改为 realpath 消解符号链接（fnm multishell 等）后沿祖先目录直查。
  if (process.argv[1] !== undefined) {
    try {
      let dir = dirname(realpathSync(process.argv[1]))
      for (let depth = 0; depth < 12; depth++) {
        const pkgDir = pathToFileURL(join(dir, 'node_modules', '@deepseek-ai', 'dsh-session') + '/')
        if (existsSync(new URL('package.json', pkgDir))) {
          push(packageEntryUrl(pkgDir)?.href)
          break
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* 入口不可读则跳过 */ }
  }
  // 2) 本仓库 pnpm 虚拟 store 中的全部副本（宿主 profile 的变体必在其中）。
  for (const pkgDir of pnpmPackageCopies(new URL('.', import.meta.url), '@deepseek-ai+dsh-session')) {
    push(packageEntryUrl(pkgDir)?.href)
  }
  return urls
}

const sessionModuleByConstructor = new WeakMap<object, Promise<DshSessionModule>>()

function findSessionModule(session: object): Promise<DshSessionModule> {
  const key = session.constructor
  let pending = sessionModuleByConstructor.get(key)
  if (pending === undefined) {
    pending = (async () => {
      const tried: string[] = []
      for (const url of await candidateModuleUrls()) {
        tried.push(url)
        const mod = (await import(/* @vite-ignore */ url)) as DshSessionModule
        if (session instanceof mod.Session) return mod
      }
      throw new Error(`遍历候选 dsh-session 副本后仍未找到与该 Session 同源的模块；已尝试: ${tried.join(' ; ')}`)
    })().catch((error: unknown) => {
      sessionModuleByConstructor.delete(key)
      throw error
    })
    sessionModuleByConstructor.set(key, pending)
  }
  return pending
}

export interface Config {
  defaultEnv: string
  envsPath?: string
  credentialStorePath?: string
}

export interface SessionCallContext {
  readonly agent?: { readonly session: Session }
}

export interface DegradedLeg {
  leg: LegReadiness['leg']
  missingRefs: string[]
}

export interface EnvTarget {
  env: string
  row: EnvRow
  readiness: LegReadiness[]
  degradedLegs: DegradedLeg[]
}

export interface ResolvedEnvBinding extends EnvTarget {
  changedAt: string
  source: EnvBindingSource
  recoveredFrom?: string
  /** Present only when this call appended a migration, recovery, or initialization record. */
  persisted?: boolean
  persistenceError?: string
}

export type EnvSwitchResult = EnvTarget & {
  ok: true
  previousEnv: string
  changedAt?: string
  source: 'tool' | 'sdk'
} & ({
  dryRun: true
} | {
  dryRun: false
  changedAt: string
  persisted: boolean
  persistenceError?: string
})

export type EnvBindingErrorCode =
  | 'UNKNOWN_ENV'
  | 'DEFAULT_ENV_INVALID'
  | 'SESSION_REQUIRED'
  | 'PROJECTION_UNAVAILABLE'
  | 'APPEND_FAILED'

export class EnvBindingError extends Error {
  readonly code: EnvBindingErrorCode

  constructor(
    code: EnvBindingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EnvBindingError'
    this.code = code
  }
}

/**
 * 按实例归属选择提交通道：本包副本的 Session 走同步快路径；宿主副本实例交给
 * `findSessionModule()` 找到的同源模块提交。参数是 unknown，避免 TS 把
 * 「非本副本实例」窄化成 never（跨副本实例在运行时真实存在，类型系统并不知情）。
 */
async function commitEnvBindingRecord(session: unknown, record: EnvBindingRecord): Promise<number> {
  if (session instanceof Session) {
    return appendPluginRecord(session, ENV_BINDING_RECORD_TYPE, record)
  }
  const host = await findSessionModule(session as object)
  return host.appendPluginRecord(session as Session, ENV_BINDING_RECORD_TYPE, record)
}

interface PersistenceResult {
  persisted: boolean
  persistenceError?: string
}

/**
 * Owns the Session-to-Env route. Plugin records are the only durable fact;
 * the projection is a derived, host-only read model.
 */
export class SessionEnvBindingStore extends Service {
  static inject = ['sessions', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultEnv: z.string().required().description('新 Session 与失效绑定恢复使用的 canonical 环境名或别名'),
    envsPath: z.string().default(defaultEnvsPath()).description('环境矩阵 YAML 路径'),
    credentialStorePath: z.string().default(defaultCredentialStorePath()).description('本地凭据库路径'),
  })

  private readonly config: Required<Config>
  private readonly operations = new WeakMap<Session, Promise<void>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'envBinding')
    this.config = {
      ...config,
      envsPath: config.envsPath ?? defaultEnvsPath(),
      credentialStorePath: config.credentialStorePath ?? defaultCredentialStorePath(),
    }
    ctx.sessionProjections.register(envBindingProjection)
  }

  async current(session: Session): Promise<ResolvedEnvBinding> {
    return this.serialize(session, () => this.currentUnlocked(session))
  }

  /** Initialize a new Session without ever overwriting an existing binding. */
  async initialize(session: Session, input: { env?: string } = {}): Promise<ResolvedEnvBinding> {
    return this.serialize(session, async () => {
      const matrix = this.matrix()
      const state = this.stateOf(session)
      if (state.record !== null) return this.currentFromState(session, matrix)
      const target = input.env === undefined
        ? this.resolveDefault(matrix)
        : this.resolveTarget(input.env, matrix)
      const source: EnvBindingSource = input.env === undefined ? 'default' : 'sdk'
      const record = await this.append(session, target.env, source)
      const persistence = await this.flush(session)
      return {
        ...target,
        changedAt: record.changedAt,
        source,
        ...persistence,
      }
    })
  }

  async switch(
    session: Session,
    input: { env: string; dryRun?: boolean },
    source: 'tool' | 'sdk',
  ): Promise<EnvSwitchResult> {
    return this.serialize(session, async () => {
      const matrix = this.matrix()
      const previous = this.currentTarget(session, matrix)
      const target = this.resolveTarget(input.env, matrix)
      if (input.dryRun === true) {
        return {
          ok: true,
          ...target,
          previousEnv: previous.env,
          source,
          dryRun: true,
        }
      }
      const record = await this.append(session, target.env, source)
      const persistence = await this.flush(session)
      return {
        ok: true,
        ...target,
        previousEnv: previous.env,
        changedAt: record.changedAt,
        source,
        dryRun: false,
        ...persistence,
      }
    })
  }

  async forCall(exec: SessionCallContext): Promise<ResolvedEnvBinding> {
    const session = exec.agent?.session
    if (session === undefined) {
      throw new EnvBindingError(
        'SESSION_REQUIRED',
        '无法从 exec.agent.session 解析调用 Session；拒绝使用全局环境作为回退',
      )
    }
    return this.current(session)
  }

  private async currentUnlocked(session: Session): Promise<ResolvedEnvBinding> {
    return this.currentFromState(session, this.matrix())
  }

  private async currentFromState(session: Session, matrix: Matrix): Promise<ResolvedEnvBinding> {
    const state = this.stateOf(session)
    const existing = state.record
    if (existing !== null) {
      const env = resolveEnvName(existing.envName, matrix)
      if (env !== undefined) {
        return {
          ...this.target(env, matrix),
          changedAt: existing.changedAt,
          source: existing.source,
        }
      }
    }

    const target = this.resolveDefault(matrix)
    const source: EnvBindingSource = existing === null ? 'migration' : 'recovery'
    const record = await this.append(session, target.env, source)
    const persistence = await this.flush(session)
    return {
      ...target,
      changedAt: record.changedAt,
      source,
      ...(existing === null ? {} : { recoveredFrom: existing.envName }),
      ...persistence,
    }
  }

  private currentTarget(session: Session, matrix: Matrix): EnvTarget {
    const existing = this.stateOf(session).record
    if (existing !== null) {
      const env = resolveEnvName(existing.envName, matrix)
      if (env !== undefined) return this.target(env, matrix)
    }
    return this.resolveDefault(matrix)
  }

  private matrix(): Matrix {
    return readMatrix(this.config.envsPath)
  }

  private resolveDefault(matrix: Matrix): EnvTarget {
    const env = resolveEnvName(this.config.defaultEnv, matrix)
    if (env === undefined) {
      throw new EnvBindingError(
        'DEFAULT_ENV_INVALID',
        `默认环境未配置或已从矩阵移除: ${this.config.defaultEnv}`,
      )
    }
    return this.target(env, matrix)
  }

  private resolveTarget(requested: string, matrix: Matrix): EnvTarget {
    const env = resolveEnvName(requested, matrix)
    if (env === undefined) {
      throw new EnvBindingError(
        'UNKNOWN_ENV',
        `未知环境: ${requested}；先调用 sentry_env_list 查看可用环境和短名`,
      )
    }
    return this.target(env, matrix)
  }

  private target(env: string, matrix: Matrix): EnvTarget {
    const row = matrix[env]
    if (row === undefined) {
      throw new EnvBindingError('UNKNOWN_ENV', `环境矩阵缺少已解析环境: ${env}`)
    }
    const readiness = credentialReadiness(row, this.config.credentialStorePath)
    return {
      env,
      row,
      readiness,
      degradedLegs: readiness
        .filter(item => !item.ok)
        .map(item => ({ leg: item.leg, missingRefs: item.missingRefs })),
    }
  }

  private stateOf(session: Session) {
    const state = this.ctx.sessionProjections.stateOf(session, ENV_BINDING_PROJECTION_KEY)
    if (state === undefined) {
      throw new EnvBindingError('PROJECTION_UNAVAILABLE', 'Session 环境绑定 projection 未注册')
    }
    return state
  }

  private async append(session: Session, env: string, source: EnvBindingSource): Promise<EnvBindingRecord> {
    const record: EnvBindingRecord = {
      v: 1,
      envName: env,
      changedAt: new Date().toISOString(),
      source,
    }
    let seq
    try {
      seq = await commitEnvBindingRecord(session, record)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new EnvBindingError(
        'APPEND_FAILED',
        `环境绑定追加失败；原绑定保持不变: ${env}（${detail}）`,
        { cause },
      )
    }
    if (this.stateOf(session).seq !== seq) {
      throw new EnvBindingError(
        'PROJECTION_UNAVAILABLE',
        '环境绑定已提交，但 projection 未推进到对应日志位置',
      )
    }
    return record
  }

  private async flush(session: Session): Promise<PersistenceResult> {
    try {
      return { persisted: await this.ctx.sessions.flush(session) }
    } catch (cause) {
      return {
        persisted: false,
        persistenceError: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  private serialize<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(session)
    let result: Promise<T>
    if (previous === undefined) {
      try {
        result = operation()
      } catch (error) {
        result = Promise.reject(error)
      }
    } else {
      result = previous.catch(() => {}).then(operation)
    }
    const tail = result.then(() => {}, () => {})
    this.operations.set(session, tail)
    void tail.then(() => {
      if (this.operations.get(session) === tail) this.operations.delete(session)
    })
    return result
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    envBinding: SessionEnvBindingStore
  }
}

export default SessionEnvBindingStore
