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
import * as logAnalyzer from '../src/index.ts'

const DP0 = 'dev-platform-hosted-0'
const TP0 = 'tst-platform-hosted-0'

function row(envLabel: string, endpoint: string, usernameRef: string, passwordRef: string): Matrix[string] {
  return {
    envLabel,
    greptimedb: { endpoint, database: 'public', usernameRef, passwordRef },
    grafana: {},
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
  dir = mkdtempSync(join(tmpdir(), 'dsh-log-session-env-'))
  const envsPath = join(dir, 'envs.yml')
  writeFileSync(envsPath, JSON.stringify({
    [DP0]: row(DP0, 'https://greptimedb.dp0.example.invalid', 'GREPTIMEDB_DP0_USERNAME', 'GREPTIMEDB_DP0_PASSWORD'),
    [TP0]: row(TP0, 'https://greptimedb.tp0.example.invalid', 'GREPTIMEDB_TP0_USERNAME', 'GREPTIMEDB_TP0_PASSWORD'),
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
  await ctx.plugin(logAnalyzer)
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

function execute(current: Session, args: { start: string, end: string }): Promise<Envelope> {
  const tool = ctx.tools.get('sentry_query_logs')
  if (tool === undefined) throw new Error('sentry_query_logs not registered')
  return tool.execute(args, { agent: { session: current } } as never) as Promise<Envelope>
}

/** One `/v1/sql` row-set whose message column carries the queried host. */
function greptimeSqlBody(host: string): Record<string, unknown> {
  return {
    output: [{
      records: {
        schema: { column_schemas: [
          { name: 'greptime_timestamp', data_type: 'timestamp' },
          { name: 'workload_name', data_type: 'String' },
          { name: 'message', data_type: 'String' },
        ] },
        rows: [[1769000000000000000, 'checkout', `ERROR connection refused at ${host}`]],
      },
    }],
  }
}

describe('Session-routed Log Provider', () => {
  it('keeps environment and backend identity on the same Session snapshot', async () => {
    vi.stubEnv('GREPTIMEDB_DP0_USERNAME', 'dp0-user')
    vi.stubEnv('GREPTIMEDB_DP0_PASSWORD', 'dp0-pass')
    vi.stubEnv('GREPTIMEDB_TP0_USERNAME', 'tp0-user')
    vi.stubEnv('GREPTIMEDB_TP0_PASSWORD', 'tp0-pass')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === '/v1/sql') return Response.json(greptimeSqlBody(url.hostname))
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const first = session('S1')
    const second = session('S2')
    await ctx.envBinding.initialize(second, { env: TP0 })

    const [firstOutput, secondOutput] = await Promise.all([
      execute(first, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' }),
      execute(second, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' }),
    ])
    expect(firstOutput.evidence.data).toMatchObject({
      env: DP0,
      backend_ref: 'greptimedb:https://greptimedb.dp0.example.invalid/public',
    })
    expect(String((firstOutput.evidence.data['logs'] as Record<string, unknown>[])[0]?.['message']))
      .toContain('greptimedb.dp0.example.invalid')
    expect(secondOutput.evidence.data).toMatchObject({
      env: TP0,
      backend_ref: 'greptimedb:https://greptimedb.tp0.example.invalid/public',
    })
    expect(String((secondOutput.evidence.data['logs'] as Record<string, unknown>[])[0]?.['message']))
      .toContain('greptimedb.tp0.example.invalid')

    await ctx.envBinding.switch(first, { env: TP0 }, 'tool')
    const switched = await execute(first, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' })
    const unaffected = await execute(second, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' })
    expect(switched.evidence.data['env']).toBe(TP0)
    expect(unaffected.evidence.data['env']).toBe(TP0)
    expect(switched.evidence.data['backend_ref']).toBe(unaffected.evidence.data['backend_ref'])
  })

  it('uses each environment credential ref for concurrent real Provider calls', async () => {
    vi.stubEnv('GREPTIMEDB_DP0_USERNAME', 'dp0-user')
    vi.stubEnv('GREPTIMEDB_DP0_PASSWORD', 'dp0-pass')
    vi.stubEnv('GREPTIMEDB_TP0_USERNAME', 'tp0-user')
    vi.stubEnv('GREPTIMEDB_TP0_PASSWORD', 'tp0-pass')
    const basicCredentials = new Map<string, string>()

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === '/v1/sql') {
        const header = String((init?.headers as Record<string, string>)['authorization'] ?? '')
        const encoded = header.replace(/^Basic /, '')
        basicCredentials.set(url.hostname, Buffer.from(encoded, 'base64').toString('utf8'))
        return Response.json(greptimeSqlBody(url.hostname))
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const first = session('S1')
    const second = session('S2')
    await ctx.envBinding.initialize(second, { env: TP0 })
    const [firstOutput, secondOutput] = await Promise.all([
      execute(first, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' }),
      execute(second, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' }),
    ])

    expect(basicCredentials).toEqual(new Map([
      ['greptimedb.dp0.example.invalid', 'dp0-user:dp0-pass'],
      ['greptimedb.tp0.example.invalid', 'tp0-user:tp0-pass'],
    ]))
    expect(firstOutput.evidence.data).toMatchObject({ env: DP0 })
    expect(secondOutput.evidence.data).toMatchObject({ env: TP0 })
  })

  it('keeps an in-flight query on its original Provider after a Session switch', async () => {
    vi.stubEnv('GREPTIMEDB_DP0_USERNAME', 'dp0-user')
    vi.stubEnv('GREPTIMEDB_DP0_PASSWORD', 'dp0-pass')
    vi.stubEnv('GREPTIMEDB_TP0_USERNAME', 'tp0-user')
    vi.stubEnv('GREPTIMEDB_TP0_PASSWORD', 'tp0-pass')
    let markReached!: () => void
    const reached = new Promise<void>(resolve => { markReached = resolve })
    let releaseResponse!: () => void
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    let gated = false

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === '/v1/sql') {
        if (!gated) {
          gated = true
          markReached()
          await responseGate
        }
        return Response.json(greptimeSqlBody(url.hostname))
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }))

    const current = session('S1')
    const pending = execute(current, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' })
    await reached
    await ctx.envBinding.switch(current, { env: TP0 }, 'tool')
    const next = await execute(current, { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:15:00Z' })
    releaseResponse()
    const original = await pending

    expect(original.evidence.data).toMatchObject({
      env: DP0,
      backend_ref: 'greptimedb:https://greptimedb.dp0.example.invalid/public',
    })
    expect(next.evidence.data).toMatchObject({
      env: TP0,
      backend_ref: 'greptimedb:https://greptimedb.tp0.example.invalid/public',
    })
  })
})
