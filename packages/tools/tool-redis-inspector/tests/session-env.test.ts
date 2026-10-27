import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SessionEnvBindingStore } from '@dsh-sentry/env-binding'
import type { Matrix } from '@dsh-sentry/env-matrix'
import SessionEnvProviders from '@dsh-sentry/service-env-provider'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as redisInspector from '../src/index.ts'

const DP0 = 'dev-platform-hosted-0'
const TP0 = 'tst-platform-hosted-0'

function row(envLabel: string, endpoint: string, passwordRef: string): Matrix[string] {
  return {
    envLabel,
    greptimedb: {},
    grafana: {},
    prometheus: {},
    dbx: { endpoint, passwordRef },
    rocketmq: {},
    zadig: {},
  }
}

class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(): unknown[] {
    return []
  }

  async assemble(): Promise<{ sections: unknown[] }> {
    return { sections: [] }
  }
}

interface Envelope {
  evidence: {
    data: Record<string, unknown>
    confidence: number
  }
}

let dir: string
let ctx: Context

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-redis-session-env-'))
  const envsPath = join(dir, 'envs.yml')
  writeFileSync(envsPath, JSON.stringify({
    [DP0]: row(DP0, 'https://dbx.dp0.example.invalid', 'DBX_DP0_PASSWORD'),
    [TP0]: row(TP0, 'https://dbx.tp0.example.invalid', 'DBX_TP0_PASSWORD'),
  }))

  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionEnvBindingStore, {
    defaultEnv: DP0,
    envsPath,
    credentialStorePath: join(dir, '.credentials.yaml'),
  })
  await ctx.plugin(SessionEnvProviders, { envsPath })
  await ctx.plugin(redisInspector, { db: 2 })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function session(id: string): Session {
  return ctx.sessions.create(SessionId(id))
}

function execute(current: Session, args: { key: string, dryRun?: boolean }): Promise<Envelope> {
  const tool = ctx.tools.get('sentry_query_redis')
  if (tool === undefined) throw new Error('sentry_query_redis not registered')
  return tool.execute(args, { agent: { session: current } } as never) as Promise<Envelope>
}

describe('Session-routed Redis Provider', () => {
  it('keeps dry-run environment and backend identity on the same Session snapshot', async () => {
    const first = session('S1')
    const second = session('S2')
    await ctx.envBinding.initialize(second, { env: TP0 })

    const [firstOutput, secondOutput] = await Promise.all([
      execute(first, { key: 'first', dryRun: true }),
      execute(second, { key: 'second', dryRun: true }),
    ])
    expect(firstOutput.evidence.data).toMatchObject({
      env: DP0,
      backend_ref: 'dbx:https://dbx.dp0.example.invalid',
      db: 2,
    })
    expect(secondOutput.evidence.data).toMatchObject({
      env: TP0,
      backend_ref: 'dbx:https://dbx.tp0.example.invalid',
    })

    await ctx.envBinding.switch(first, { env: TP0 }, 'tool')
    const switched = await execute(first, { key: 'first', dryRun: true })
    const unaffected = await execute(second, { key: 'second', dryRun: true })
    expect(switched.evidence.data['env']).toBe(TP0)
    expect(unaffected.evidence.data['env']).toBe(TP0)
    expect(switched.evidence.data['backend_ref']).toBe(unaffected.evidence.data['backend_ref'])
  })

  it('uses each environment credential ref for concurrent real Provider calls', async () => {
    vi.stubEnv('DBX_DP0_PASSWORD', 'dp0-secret')
    vi.stubEnv('DBX_TP0_PASSWORD', 'tp0-secret')
    const loginPasswords = new Map<string, string>()

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const host = url.hostname
      if (url.pathname === '/api/auth/login') {
        const body = JSON.parse(String(init?.body)) as { password: string }
        loginPasswords.set(host, body.password)
        return new Response('{}', { headers: { 'set-cookie': `dbx_session=${host}-session` } })
      }
      if (url.pathname === '/api/connection/list') {
        return Response.json([{ id: `redis-${host}`, db_type: 'redis' }])
      }
      if (url.pathname === '/api/connection/connect') {
        return Response.json({ id: `redis-${host}` })
      }
      if (url.pathname === '/api/redis/get-value') {
        return Response.json({
          key_display: 'session:user:1',
          key_raw: 'a2V5',
          ttl: 60,
          redis_type: 'string',
          data: {
            content: {
              raw_base64: Buffer.from(host, 'utf8').toString('base64'),
              encoding: 'utf8',
            },
          },
        })
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const first = session('S1')
    const second = session('S2')
    await ctx.envBinding.initialize(second, { env: TP0 })
    const [firstOutput, secondOutput] = await Promise.all([
      execute(first, { key: 'session:user:1' }),
      execute(second, { key: 'session:user:1' }),
    ])

    expect(loginPasswords).toEqual(new Map([
      ['dbx.dp0.example.invalid', 'dp0-secret'],
      ['dbx.tp0.example.invalid', 'tp0-secret'],
    ]))
    expect(firstOutput.evidence.data).toMatchObject({ env: DP0, value: 'dbx.dp0.example.invalid' })
    expect(secondOutput.evidence.data).toMatchObject({ env: TP0, value: 'dbx.tp0.example.invalid' })
  })

  it('keeps an in-flight query on its original Provider after a Session switch', async () => {
    vi.stubEnv('DBX_DP0_PASSWORD', 'dp0-secret')
    vi.stubEnv('DBX_TP0_PASSWORD', 'tp0-secret')
    let markReached!: () => void
    const reached = new Promise<void>(resolve => { markReached = resolve })
    let releaseResponse!: () => void
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === '/api/auth/login') {
        return new Response('{}', { headers: { 'set-cookie': 'dbx_session=session' } })
      }
      if (url.pathname === '/api/connection/list') return Response.json([{ id: 'redis', db_type: 'redis' }])
      if (url.pathname === '/api/connection/connect') return Response.json({ id: 'redis' })
      if (url.pathname === '/api/redis/get-value') {
        markReached()
        await responseGate
        return Response.json({ data: { content: { raw_base64: '', encoding: 'utf8' } } })
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const current = session('S1')
    const pending = execute(current, { key: 'session:user:1' })
    await reached
    await ctx.envBinding.switch(current, { env: TP0 }, 'tool')
    const next = await execute(current, { key: 'next', dryRun: true })
    releaseResponse()
    const original = await pending

    expect(original.evidence.data).toMatchObject({
      env: DP0,
      backend_ref: 'dbx:https://dbx.dp0.example.invalid',
    })
    expect(next.evidence.data).toMatchObject({
      env: TP0,
      backend_ref: 'dbx:https://dbx.tp0.example.invalid',
    })
  })
})
