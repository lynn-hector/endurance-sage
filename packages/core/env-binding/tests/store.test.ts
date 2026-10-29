import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  appendPluginRecord,
  pluginRecordOf,
  SessionId,
  SessionStore,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { EnvRow, Matrix } from '@dsh-sentry/env-matrix'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENV_BINDING_RECORD_TYPE,
  EnvBindingError,
  SessionEnvBindingStore,
  type EnvBindingRecord,
} from '../src/index.ts'
import { envBindingRecordSchema } from '../src/record.ts'

function row(envLabel: string, grafana: EnvRow['grafana'] = {}): EnvRow {
  return {
    envLabel,
    greptimedb: {},
    grafana,
    prometheus: {},
    dbx: {},
    rocketmq: {},
    zadig: {},
  }
}

const matrix: Matrix = {
  'dev-platform-hosted-0': row('dev-platform-hosted-0'),
  'tst-platform-hosted-0': row('tst-platform-hosted-0', {
    usernameRef: 'GRAFANA_TP0_USERNAME',
    passwordRef: 'GRAFANA_TP0_PASSWORD',
  }),
}

let dir: string
let envsPath: string
let credentialStorePath: string
let contexts: Context[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-binding-'))
  envsPath = join(dir, 'envs.yml')
  credentialStorePath = join(dir, '.credentials.yaml')
  writeFileSync(envsPath, JSON.stringify(matrix))
  contexts = []
})

afterEach(async () => {
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  rmSync(dir, { recursive: true, force: true })
})

async function createRuntime(defaultEnv = 'dev-platform-hosted-0'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionEnvBindingStore, {
    defaultEnv,
    envsPath,
    credentialStorePath,
  })
  return ctx
}

function watch(ctx: Context, session: Session): SessionEvent[] {
  const events: SessionEvent[] = []
  ctx.on('session/event', (candidate, event) => {
    if (candidate === session) events.push(event)
  })
  return events
}

function bindingRecords(events: readonly SessionEvent[]): EnvBindingRecord[] {
  return events.flatMap((event) => {
    const record = pluginRecordOf(event)
    if (record?.type !== ENV_BINDING_RECORD_TYPE) return []
    const parsed = envBindingRecordSchema.safeParse(record.data)
    return parsed.success ? [parsed.data] : []
  })
}

function session(ctx: Context, id: string): Session {
  return ctx.sessions.create(SessionId(id))
}

describe('SessionEnvBindingStore', () => {
  it('keeps bindings independent across Sessions and serializes explicit switches', async () => {
    const ctx = await createRuntime()
    const first = session(ctx, 'S1')
    const second = session(ctx, 'S2')
    const firstEvents = watch(ctx, first)
    const secondEvents = watch(ctx, second)

    await ctx.envBinding.initialize(first)
    await ctx.envBinding.initialize(second, { env: 'TP0' })
    const transitions = await Promise.all([
      ctx.envBinding.switch(first, { env: 'TP0' }, 'tool'),
      ctx.envBinding.switch(first, { env: 'DP0' }, 'tool'),
    ])

    expect(transitions.map(item => [item.previousEnv, item.env])).toEqual([
      ['dev-platform-hosted-0', 'tst-platform-hosted-0'],
      ['tst-platform-hosted-0', 'dev-platform-hosted-0'],
    ])
    expect((await ctx.envBinding.current(first)).env).toBe('dev-platform-hosted-0')
    expect((await ctx.envBinding.current(second)).env).toBe('tst-platform-hosted-0')
    expect(bindingRecords(firstEvents).map(item => item.envName)).toEqual([
      'dev-platform-hosted-0',
      'tst-platform-hosted-0',
      'dev-platform-hosted-0',
    ])
    expect(bindingRecords(secondEvents)).toHaveLength(1)
  })

  it('restores the last binding in a second Context from the real event seed', async () => {
    const firstCtx = await createRuntime()
    const original = session(firstCtx, 'S-resume')
    const events = watch(firstCtx, original)
    await firstCtx.envBinding.initialize(original)
    await firstCtx.envBinding.switch(original, { env: 'TP0' }, 'tool')

    const secondCtx = await createRuntime()
    const restored = secondCtx.sessions.create(SessionId('S-resume'), { seed: events })
    const restoredEvents = watch(secondCtx, restored)
    const current = await secondCtx.envBinding.current(restored)

    expect(current).toMatchObject({
      env: 'tst-platform-hosted-0',
      source: 'tool',
    })
    expect(current.persisted).toBeUndefined()
    expect(bindingRecords(restoredEvents)).toHaveLength(0)
  })

  it('inherits a fork binding and then lets parent and child switch independently', async () => {
    const ctx = await createRuntime()
    const parent = session(ctx, 'S-parent')
    await ctx.envBinding.initialize(parent, { env: 'TP0' })
    const child = ctx.sessions.fork(parent, undefined, SessionId('S-child'))

    expect((await ctx.envBinding.current(child)).env).toBe('tst-platform-hosted-0')
    await ctx.envBinding.switch(parent, { env: 'DP0' }, 'tool')
    expect((await ctx.envBinding.current(child)).env).toBe('tst-platform-hosted-0')
    await ctx.envBinding.switch(child, { env: 'DP0' }, 'sdk')
    expect((await ctx.envBinding.current(parent)).env).toBe('dev-platform-hosted-0')
    expect((await ctx.envBinding.current(child)).source).toBe('sdk')
  })

  it('migrates a legacy Session once under concurrent first recovery', async () => {
    const ctx = await createRuntime()
    const legacy = session(ctx, 'S-legacy')
    legacy.append('turn/start', { turn: 1 })
    const events = watch(ctx, legacy)

    const results = await Promise.all(Array.from({ length: 12 }, () => ctx.envBinding.current(legacy)))

    expect(results.every(item => item.env === 'dev-platform-hosted-0')).toBe(true)
    expect(results[0]?.source).toBe('migration')
    expect(bindingRecords(events)).toHaveLength(1)
    expect(bindingRecords(events)[0]?.source).toBe('migration')
  })

  it('recovers from a removed last Env without reviving an older valid Env', async () => {
    const ctx = await createRuntime()
    const restored = session(ctx, 'S-recovery')
    const events = watch(ctx, restored)
    appendPluginRecord(restored, ENV_BINDING_RECORD_TYPE, {
      v: 1,
      envName: 'tst-platform-hosted-0',
      changedAt: '2026-10-26T00:00:00.000Z',
      source: 'tool',
    })
    appendPluginRecord(restored, ENV_BINDING_RECORD_TYPE, {
      v: 1,
      envName: 'retired-environment',
      changedAt: '2026-10-26T00:01:00.000Z',
      source: 'tool',
    })

    const results = await Promise.all([
      ctx.envBinding.current(restored),
      ctx.envBinding.current(restored),
    ])

    expect(results[0]).toMatchObject({
      env: 'dev-platform-hosted-0',
      source: 'recovery',
      recoveredFrom: 'retired-environment',
    })
    expect(bindingRecords(events).map(item => item.source)).toEqual(['tool', 'tool', 'recovery'])
  })

  it('reports no durability listener without rolling back the live binding', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-no-listener')

    const result = await ctx.envBinding.switch(current, { env: 'TP0' }, 'tool')

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      env: 'tst-platform-hosted-0',
      persisted: false,
    })
    expect((await ctx.envBinding.current(current)).env).toBe('tst-platform-hosted-0')
  })

  it('confirms a successful durability checkpoint', async () => {
    const ctx = await createRuntime()
    ctx.on('session/flush', () => {})
    const current = session(ctx, 'S-flushed')

    const result = await ctx.envBinding.switch(current, { env: 'TP0' }, 'tool')

    if (result.dryRun) throw new Error('expected a committed switch')
    expect(result.persisted).toBe(true)
    expect(result.persistenceError).toBeUndefined()
  })

  it('returns an identifiable flush failure while retaining the committed binding', async () => {
    const ctx = await createRuntime()
    ctx.on('session/flush', () => {
      throw new Error('durability backend unavailable')
    })
    const current = session(ctx, 'S-flush-failure')

    const result = await ctx.envBinding.switch(current, { env: 'TP0' }, 'tool')

    expect(result).toMatchObject({
      ok: true,
      env: 'tst-platform-hosted-0',
      persisted: false,
      persistenceError: 'durability backend unavailable',
    })
    expect((await ctx.envBinding.current(current)).env).toBe('tst-platform-hosted-0')
  })

  it('preserves the old binding and returns no success when append fails', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-append-failure')
    await ctx.envBinding.initialize(current)
    let attempted: Promise<unknown> | undefined
    ctx.on('session/event', (candidate, event) => {
      if (candidate === current && event.type === 'turn/start' && event.data.turn === 99) {
        attempted = ctx.envBinding.switch(candidate, { env: 'TP0' }, 'tool')
        void Promise.resolve(attempted).catch(() => {})
      }
    })

    current.append('turn/start', { turn: 99 })

    expect(attempted).toBeDefined()
    await expect(attempted).rejects.toMatchObject({
      name: 'EnvBindingError',
      code: 'APPEND_FAILED',
    })
    expect((await ctx.envBinding.current(current)).env).toBe('dev-platform-hosted-0')
  })

  it('validates dryRun without appending or flushing', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-dry-run')
    await ctx.envBinding.initialize(current)
    const events = watch(ctx, current)
    let flushes = 0
    ctx.on('session/flush', () => {
      flushes += 1
    })

    const result = await ctx.envBinding.switch(current, { env: 'TP0', dryRun: true }, 'tool')

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      previousEnv: 'dev-platform-hosted-0',
      env: 'tst-platform-hosted-0',
      degradedLegs: [{
        leg: 'grafana',
        missingRefs: ['GRAFANA_TP0_USERNAME', 'GRAFANA_TP0_PASSWORD'],
      }],
    })
    expect('persisted' in result).toBe(false)
    expect(bindingRecords(events)).toHaveLength(0)
    expect(flushes).toBe(0)
    expect((await ctx.envBinding.current(current)).env).toBe('dev-platform-hosted-0')
  })

  it('ignores unrelated events and malformed payloads in the projection', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-invalid-payload')
    await ctx.envBinding.initialize(current, { env: 'TP0' })
    current.append('turn/start', { turn: 1 })
    appendPluginRecord(current, ENV_BINDING_RECORD_TYPE, {
      v: 1,
      envName: 'dev-platform-hosted-0',
      changedAt: 'not-a-date',
      source: 'tool',
      credentialRef: 'must-not-be-admitted',
    } as unknown as EnvBindingRecord)

    const resolved = await ctx.envBinding.current(current)

    expect(resolved.env).toBe('tst-platform-hosted-0')
    expect(resolved.source).toBe('sdk')
  })

  it('writes only canonical routing metadata and keeps records off the model surface', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-metadata')
    const events = watch(ctx, current)
    await ctx.envBinding.switch(current, { env: 'TP0' }, 'tool')
    const records = bindingRecords(events)

    expect(records).toHaveLength(1)
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(['changedAt', 'envName', 'source', 'v'])
    expect(records[0]?.envName).toBe('tst-platform-hosted-0')
    expect(JSON.stringify(records[0])).not.toMatch(/endpoint|credential|token|cookie|password/i)
    expect(current.deriveMessages()).toEqual([])
  })

  it('routes forCall only through exec.agent.session', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-call')
    await ctx.envBinding.initialize(current, { env: 'TP0' })

    await expect(ctx.envBinding.forCall({ agent: { session: current } }))
      .resolves.toMatchObject({ env: 'tst-platform-hosted-0' })
    await expect(ctx.envBinding.forCall({})).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    })
  })

  it('rejects unknown targets and invalid defaults without writing a fallback route', async () => {
    const ctx = await createRuntime()
    const current = session(ctx, 'S-invalid-target')
    await ctx.envBinding.initialize(current)
    const events = watch(ctx, current)

    await expect(ctx.envBinding.switch(current, { env: 'not-configured' }, 'tool'))
      .rejects.toMatchObject({ code: 'UNKNOWN_ENV' })
    expect(bindingRecords(events)).toHaveLength(0)

    const invalidCtx = await createRuntime('missing-default')
    const legacy = session(invalidCtx, 'S-invalid-default')
    const legacyEvents = watch(invalidCtx, legacy)
    await expect(invalidCtx.envBinding.current(legacy)).rejects.toEqual(
      expect.objectContaining<Partial<EnvBindingError>>({ code: 'DEFAULT_ENV_INVALID' }),
    )
    expect(bindingRecords(legacyEvents)).toHaveLength(0)
  })

  it('exposes the stored preference, effective default, and assembly fallback', async () => {
    writeFileSync(credentialStorePath, 'DSH_SENTRY_DEFAULT_ENV: TP0\n')
    const ctx = await createRuntime()

    expect(ctx.envBinding.defaultEnv()).toEqual({
      preference: 'tst-platform-hosted-0',
      effectiveEnv: 'tst-platform-hosted-0',
      assemblyEnv: 'dev-platform-hosted-0',
    })
  })

  it('exposes the effective machine-global code base dir from the configured store', async () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '')
    writeFileSync(credentialStorePath, 'DSH_SENTRY_CODE_BASE: /store/novoone-backend\n')
    const ctx = await createRuntime()

    expect(ctx.envBinding.globalConfig()).toEqual({ codeBaseDir: '/store/novoone-backend' })
    vi.unstubAllEnvs()
  })

  it('prefers the DSH_SENTRY_DEFAULT_ENV store key over the assembly default', async () => {
    writeFileSync(credentialStorePath, 'DSH_SENTRY_DEFAULT_ENV: TP0\n')
    const ctx = await createRuntime()
    const current = session(ctx, 'S-preferred-default')

    // 别名与 canonical 名都可解析；偏好对已绑定 Session 不重绑
    await expect(ctx.envBinding.initialize(current)).resolves.toMatchObject({
      env: 'tst-platform-hosted-0',
      source: 'default',
    })
  })

  it('applies a saved default-env preference to the next new Session without restart', async () => {
    const ctx = await createRuntime()
    const first = session(ctx, 'S-default-before')
    await ctx.envBinding.initialize(first)
    expect((await ctx.envBinding.current(first)).env).toBe('dev-platform-hosted-0')

    // Web 设置页经 remote.credentials.set 落盘后，同一宿主进程内的下一个新 Session 生效
    writeFileSync(credentialStorePath, 'DSH_SENTRY_DEFAULT_ENV: tst-platform-hosted-0\n')
    const second = session(ctx, 'S-default-after')
    await expect(ctx.envBinding.initialize(second)).resolves.toMatchObject({
      env: 'tst-platform-hosted-0',
      source: 'default',
    })
    expect((await ctx.envBinding.current(first)).env).toBe('dev-platform-hosted-0')
  })

  it('degrades to the assembly default when the stored preference no longer resolves', async () => {
    writeFileSync(credentialStorePath, 'DSH_SENTRY_DEFAULT_ENV: env-removed-from-matrix\n')
    const ctx = await createRuntime()
    const current = session(ctx, 'S-stale-preference')

    await expect(ctx.envBinding.initialize(current)).resolves.toMatchObject({
      env: 'dev-platform-hosted-0',
      source: 'default',
    })
  })
})
