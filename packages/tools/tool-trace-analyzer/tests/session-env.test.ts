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
import * as traceAnalyzer from '../src/index.ts'

const DP0 = 'dev-platform-hosted-0'
const TP0 = 'tst-platform-hosted-0'

function row(envLabel: string, endpoint: string, usernameRef: string, passwordRef: string, datasourceUid: string): Matrix[string] {
  return {
    envLabel,
    greptimedb: {},
    grafana: { endpoint, usernameRef, passwordRef, greptimedbJaegerDatasourceUid: datasourceUid },
    prometheus: {},
    dbx: {},
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
  dir = mkdtempSync(join(tmpdir(), 'dsh-trace-session-env-'))
  const envsPath = join(dir, 'envs.yml')
  writeFileSync(envsPath, JSON.stringify({
    [DP0]: row(DP0, 'https://grafana.dp0.example.invalid', 'GRAFANA_DP0_USERNAME', 'GRAFANA_DP0_PASSWORD', 'jaeger-dp0'),
    [TP0]: row(TP0, 'https://grafana.tp0.example.invalid', 'GRAFANA_TP0_USERNAME', 'GRAFANA_TP0_PASSWORD', 'jaeger-tp0'),
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
  await ctx.plugin(traceAnalyzer)
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

function execute(current: Session, args: { traceId: string }): Promise<Envelope> {
  const tool = ctx.tools.get('sentry_fetch_trace')
  if (tool === undefined) throw new Error('sentry_fetch_trace not registered')
  return tool.execute(args, { agent: { session: current } } as never) as Promise<Envelope>
}

/** One Grafana Jaeger frame row per span; fields follow the conservative parser's names. */
function grafanaQueryBody(host: string): Record<string, unknown> {
  return {
    results: {
      A: {
        frames: [{
          schema: { fields: ['traceID', 'spanID', 'parentSpanID', 'operationName', 'serviceName', 'duration', 'tags', 'stackTraces'].map(name => ({ name })) },
          data: { values: [
            [`trace-at-${host}`],
            ['span-1'],
            [null],
            ['GET /orders'],
            [`svc-${host}`],
            [125],
            [[]],
            [[]],
          ] },
        }],
      },
    },
  }
}

describe('Session-routed Trace Provider', () => {
  it('keeps environment and backend identity on the same Session snapshot', async () => {
    vi.stubEnv('GRAFANA_DP0_USERNAME', 'dp0-user')
    vi.stubEnv('GRAFANA_DP0_PASSWORD', 'dp0-pass')
    vi.stubEnv('GRAFANA_TP0_USERNAME', 'tp0-user')
    vi.stubEnv('GRAFANA_TP0_PASSWORD', 'tp0-pass')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const host = url.hostname
      if (url.pathname === '/login') {
        return new Response('{}', { headers: { 'set-cookie': `grafana_session=${host}-session` } })
      }
      if (url.pathname === '/api/ds/query') {
        return Response.json(grafanaQueryBody(host))
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const first = session('S1')

    const second = session('S2')
    await ctx.envBinding.initialize(second, { env: TP0 })

    const [firstOutput, secondOutput] = await Promise.all([
      execute(first, { traceId: 'trace-1' }),
      execute(second, { traceId: 'trace-2' }),
    ])
    expect(firstOutput.evidence.data).toMatchObject({
      env: DP0,
      backend_ref: 'grafana:jaeger-dp0',
      services: ['svc-grafana.dp0.example.invalid'],
    })
    expect(secondOutput.evidence.data).toMatchObject({
      env: TP0,
      backend_ref: 'grafana:jaeger-tp0',
      services: ['svc-grafana.tp0.example.invalid'],
    })

    await ctx.envBinding.switch(first, { env: TP0 }, 'tool')
    const switched = await execute(first, { traceId: 'trace-3' })
    const unaffected = await execute(second, { traceId: 'trace-4' })
    expect(switched.evidence.data['env']).toBe(TP0)
    expect(unaffected.evidence.data['env']).toBe(TP0)
    expect(switched.evidence.data['backend_ref']).toBe(unaffected.evidence.data['backend_ref'])
  })

  it('uses each environment credential ref for concurrent real Provider calls', async () => {
    vi.stubEnv('GRAFANA_DP0_USERNAME', 'dp0-user')
    vi.stubEnv('GRAFANA_DP0_PASSWORD', 'dp0-pass')
    vi.stubEnv('GRAFANA_TP0_USERNAME', 'tp0-user')
    vi.stubEnv('GRAFANA_TP0_PASSWORD', 'tp0-pass')
    const loginBodies = new Map<string, { user: string, password: string }>()

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const host = url.hostname
      if (url.pathname === '/login') {
        const body = JSON.parse(String(init?.body)) as { user: string, password: string }
        loginBodies.set(host, body)
        return new Response('{}', { headers: { 'set-cookie': `grafana_session=${host}-session` } })
      }
      if (url.pathname === '/api/ds/query') {
        return Response.json(grafanaQueryBody(host))
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const first = session('S1')
    const second = session('S2')
    await ctx.envBinding.initialize(second, { env: TP0 })
    const [firstOutput, secondOutput] = await Promise.all([
      execute(first, { traceId: 'trace-1' }),
      execute(second, { traceId: 'trace-2' }),
    ])

    expect(loginBodies).toEqual(new Map([
      ['grafana.dp0.example.invalid', { user: 'dp0-user', password: 'dp0-pass' }],
      ['grafana.tp0.example.invalid', { user: 'tp0-user', password: 'tp0-pass' }],
    ]))
    expect(firstOutput.evidence.data).toMatchObject({
      env: DP0,
      services: ['svc-grafana.dp0.example.invalid'],
    })
    expect(secondOutput.evidence.data).toMatchObject({
      env: TP0,
      services: ['svc-grafana.tp0.example.invalid'],
    })
  })

  it('keeps an in-flight query on its original Provider after a Session switch', async () => {
    vi.stubEnv('GRAFANA_DP0_USERNAME', 'dp0-user')
    vi.stubEnv('GRAFANA_DP0_PASSWORD', 'dp0-pass')
    vi.stubEnv('GRAFANA_TP0_USERNAME', 'tp0-user')
    vi.stubEnv('GRAFANA_TP0_PASSWORD', 'tp0-pass')
    let markReached!: () => void
    const reached = new Promise<void>(resolve => { markReached = resolve })
    let releaseResponse!: () => void
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    let gated = false

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === '/login') {
        return new Response('{}', { headers: { 'set-cookie': 'grafana_session=session' } })
      }
      if (url.pathname === '/api/ds/query') {
        if (!gated) {
          gated = true
          markReached()
          await responseGate
        }
        return Response.json(grafanaQueryBody(url.hostname))
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const current = session('S1')
    const pending = execute(current, { traceId: 'trace-1' })
    await reached
    await ctx.envBinding.switch(current, { env: TP0 }, 'tool')
    const next = await execute(current, { traceId: 'trace-2' })
    releaseResponse()
    const original = await pending

    expect(original.evidence.data).toMatchObject({
      env: DP0,
      backend_ref: 'grafana:jaeger-dp0',
      services: ['svc-grafana.dp0.example.invalid'],
    })
    expect(next.evidence.data).toMatchObject({
      env: TP0,
      backend_ref: 'grafana:jaeger-tp0',
      services: ['svc-grafana.tp0.example.invalid'],
    })
  })
})
