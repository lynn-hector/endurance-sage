#!/usr/bin/env node
/**
 * Real DSH core probe for Session-scoped Env routing.
 *
 * The writer and resume phases run in separate OS processes. No model request
 * or sentry backend call is made; AgentLoop, ToolRuntime and JSONL persistence
 * are the same public components mounted by the DSH base bundle.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  buildForkSeed,
  SessionId,
  SessionLogOffset,
  SessionStore,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionEnvBindingStore } from '@dsh-sentry/env-binding'
import type { EnvRow, Matrix } from '@dsh-sentry/env-matrix'

const DP0 = 'dev-platform-hosted-0'
const TP0 = 'tst-platform-hosted-0'
const TP1 = 'tst-platform-hosted-1'

function row(envLabel: string): EnvRow {
  return {
    envLabel,
    greptimedb: {},
    grafana: {},
    prometheus: {},
    dbx: {},
    rocketmq: {},
    zadig: {},
  }
}

const matrix: Matrix = {
  [DP0]: row(DP0),
  [TP0]: row(TP0),
  [TP1]: row(TP1),
}

interface ProbeValue {
  sessionId: string
  env: string
  source: string
  persisted?: boolean
}

class ProbeCompactionEngine extends BasicCompactionEngine {
  protected override async summarize() {
    const summary = [{ type: 'text' as const, text: 'Compacted probe history.' }]
    return {
      summary,
      rawOutput: summary,
      provider: 'probe',
      model: 'probe',
      maxTokens: 128,
    }
  }
}

function probePlugin(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'sentry_env_probe',
    description: 'Internal host probe; never mounted by the production assembly.',
    parameters: {
      env: { type: 'string', description: 'Optional target environment.' },
      delayMs: { type: 'number', default: 0 },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (args.delayMs !== undefined && args.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, args.delayMs))
      }
      let persisted: boolean | undefined
      if (args.env !== undefined) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('probe requires an Agent Session')
        const switched = await ctx.envBinding.switch(session, { env: args.env }, 'tool')
        if (!switched.dryRun) persisted = switched.persisted
      }
      const current = await ctx.envBinding.forCall(exec)
      persisted ??= current.persisted
      return {
        sessionId: String(exec.agent?.session.id),
        env: current.env,
        source: current.source,
        ...(persisted === undefined ? {} : { persisted }),
      } as unknown as JsonValue
    },
  }))
}

async function createRuntime(root: string, sessionRoot = join(root, 'sessions')): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, {
    root: sessionRoot,
    compression: 'none',
  })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })
  await ctx.plugin(ProbeCompactionEngine, { auto: false })
  await ctx.plugin(SessionEnvBindingStore, {
    defaultEnv: DP0,
    envsPath: join(root, 'envs.yml'),
    credentialStorePath: join(root, '.credentials.yaml'),
  })
  await ctx.plugin({ inject: ['tools', 'envBinding'], apply: probePlugin })
  return ctx
}

let callSequence = 0
async function execute(
  ctx: Context,
  agent: { session: Session },
  input: { env?: string; delayMs?: number } = {},
): Promise<ProbeValue> {
  const result = await ctx.tools.execute({
    callId: ToolCallId(`env-probe-${process.pid}-${callSequence++}`),
    name: 'sentry_env_probe',
    arguments: input,
    agent: agent as never,
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(JSON.stringify(result.error))
  return result.value as unknown as ProbeValue
}

function watch(ctx: Context, session: Session): SessionEvent[] {
  const events: SessionEvent[] = []
  ctx.on('session/event', (candidate, event) => {
    if (candidate === session) events.push(event)
  })
  return events
}

function appendProbeHistory(session: Session) {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('system/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId('probe-system'),
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'Probe system prompt.' }],
    },
  }, { surfaceOp: 'append' })
  const appendUser = (id: string) => session.append('user/message', {
    id: MessageId(id),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `${id}: ${'environment-routing-history '.repeat(100)}` }],
  }, { surfaceOp: 'append' })
  const first = appendUser('probe-user-1')
  const second = appendUser('probe-user-2')
  appendUser('probe-user-3')
  return { start: first.seq, end: second.seq }
}

async function writer(root: string): Promise<void> {
  const ctx = await createRuntime(root)
  try {
    const first = await ctx.agents.create({
      sessionId: SessionId('S1'),
      agentOptions: { provider: 'probe', model: 'probe' },
    })
    const second = await ctx.agents.create({
      sessionId: SessionId('S2'),
      agentOptions: { provider: 'probe', model: 'probe' },
    })
    const firstEvents = watch(ctx, first.agent.session)

    assert.deepEqual(await execute(ctx, first.agent, { env: DP0 }), {
      sessionId: 'S1', env: DP0, source: 'tool', persisted: true,
    })
    assert.deepEqual(await execute(ctx, second.agent, { env: TP0 }), {
      sessionId: 'S2', env: TP0, source: 'tool', persisted: true,
    })
    const concurrent = await Promise.all([
      execute(ctx, first.agent, { delayMs: 30 }),
      execute(ctx, second.agent, { delayMs: 5 }),
    ])
    assert.deepEqual(concurrent.map(item => [item.sessionId, item.env]), [
      ['S1', DP0],
      ['S2', TP0],
    ])

    await execute(ctx, first.agent, { env: 'TP1' })
    assert.equal((await execute(ctx, second.agent)).env, TP0)

    const boundary = firstEvents.at(-1)?.seq
    if (boundary === undefined) throw new Error('fork boundary is missing')
    const inheritedEventCount = SessionLogOffset(firstEvents.length)
    const child = await ctx.agents.create({
      sessionId: SessionId('S1-child'),
      parentAgent: first.agent,
      agentOptions: { provider: 'probe', model: 'probe' },
      seed: buildForkSeed(firstEvents, boundary),
      inheritedEventCount,
      meta: { parentSession: first.agent.session.id, isSeeded: true },
    })
    assert.equal((await execute(ctx, child.agent)).env, TP1)
    await execute(ctx, child.agent, { env: DP0 })
    assert.equal((await execute(ctx, first.agent)).env, TP1)
    assert.equal((await execute(ctx, child.agent)).env, DP0)

    const region = appendProbeHistory(first.agent.session)
    await ctx.compaction.compactRegion(region.start, region.end, first.agent)
    assert.equal((await execute(ctx, first.agent)).env, TP1)

    console.log(JSON.stringify({ phase: 'writer', ok: true, concurrent, fork: 'independent', compact: 'preserved' }))
  } finally {
    await ctx.fiber.dispose()
  }
}

async function resume(root: string): Promise<void> {
  const ctx = await createRuntime(root, join(root, 'exported-sessions'))
  try {
    const expected = new Map([
      ['S1', TP1],
      ['S2', TP0],
      ['S1-child', DP0],
    ])
    const restored: ProbeValue[] = []
    for (const [id, env] of expected) {
      const handle = await ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: { provider: 'probe', model: 'probe' },
      })
      const value = await execute(ctx, handle.agent)
      assert.equal(value.sessionId, id)
      assert.equal(value.env, env)
      assert.equal(value.source, 'tool')
      assert.equal(value.persisted, undefined)
      restored.push(value)
    }
    console.log(JSON.stringify({ phase: 'resume', ok: true, restored }))
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runChild(mode: 'writer' | 'resume', root: string): Promise<string> {
  const script = fileURLToPath(import.meta.url)
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, mode, root], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${mode} probe failed: code=${String(code)} signal=${String(signal)}\n${stdout}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function main(): Promise<void> {
  const [mode, rootArg] = process.argv.slice(2)
  if ((mode === 'writer' || mode === 'resume') && rootArg !== undefined) {
    await (mode === 'writer' ? writer(rootArg) : resume(rootArg))
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'dsh-session-env-probe-'))
  try {
    writeFileSync(join(root, 'envs.yml'), JSON.stringify(matrix))
    const writerOutput = await runChild('writer', root)
    cpSync(join(root, 'sessions'), join(root, 'exported-sessions'), { recursive: true })
    const resumeOutput = await runChild('resume', root)
    process.stdout.write(writerOutput)
    process.stdout.write(resumeOutput)
    console.log('DSH Session Env probe OK (separate writer/resume processes)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
