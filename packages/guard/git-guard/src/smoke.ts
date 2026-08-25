/** Standalone smoke test: git-guard pre-execute (方案 A) + terminal guard (方案 B). */
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from './index.ts'

type Decision = { kind: string; reason?: string }

const listeners: Array<(exec: any, next: () => Promise<Decision>) => Promise<Decision>> = []
const guards: Array<(exec: any) => string | undefined> = []
const fakeCtx = {
  on: (_event: string, fn: any) => { listeners.push(fn) },
  tools: {
    register: () => {},
    guard: (fn: any) => { guards.push(fn); return () => {} },
  },
} as unknown as Context

apply(fakeCtx, Config({}) as any)

/** Full pipeline: pre-execute decision, then guard re-assertion (deny-only). */
const run = async (name: string, args: unknown): Promise<void> => {
  const pre = await listeners[0]!({ name, arguments: args }, async () => ({ kind: 'allow' }) as Decision)
  // Guard runs after the whole waterfall — even an "allow" (or an approved "ask") passes through it.
  const guardReason = guards[0]!({ name, arguments: args })
  const final = guardReason !== undefined ? `DENIED-BY-GUARD` : pre.kind
  const detail = guardReason ?? pre.reason ?? ''
  console.log(`${name.padEnd(6)} ${(args as any).command.padEnd(34)} -> ${final.padEnd(17)} ${detail.slice(0, 52)}`)
}

const cases: Array<[string, string]> = [
  ['bash', 'git clean -nd'],
  ['bash', 'git reset --hard HEAD~1'],
  ['bash', 'git push origin main'],
  ['bash', 'git push --force origin main'],
  ['bash', 'git push --force-with-lease origin main'],
  ['bash', 'git branch -D feature-x'],
  ['bash', 'git status'],
  ['bash', 'ls -la'],
  ['zadig', 'git push'],
]

for (const [tool, cmd] of cases) await run(tool, { command: cmd })
