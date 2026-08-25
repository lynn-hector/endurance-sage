/**
 * git-guard —— 危险 git 命令门禁（方案 A + B 分层）。
 *
 * 两层策略：
 * - 方案 A（tools/pre-execute 瀑布）：deny 破坏性命令、ask 影响远端的命令
 *   （走审批弹窗），可被后续 listener 继续参与决策。
 * - 方案 B（ctx.tools.guard() 终审）：deny-only、同步、不可被任何 listener
 *   强制放行——绝对红线（历史改写、工作区丢弃）兜底，防止将来其他插件的
 *   pre-execute 决策意外覆盖本插件。
 *
 * 已知局限（明示，不隐瞒）：对命令字符串做正则匹配是「防误操作」护栏而非
 * 安全边界——引用展开、变量拼接、间接调用（sh -c "$(…)"）可绕过。
 *
 * @module @dsh-sentry/guard-git
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sentry-git-guard'

export const inject = ['tools']

/** Plugin config; validated and defaulted by the schema below. */
export interface Config {
  /** Tool names whose `command` (or equivalent) argument holds the shell command. */
  toolNames?: string[]
  /** Regex sources (unanchored) that always deny. */
  denyPatterns?: string[]
  /** Regex sources (unanchored) routed to the approval seam. */
  askPatterns?: string[]
  /** Regex sources (unanchored) enforced again by the deny-only terminal guard. */
  hardDenyPatterns?: string[]
  /** Extra text fields on the tool args to scan (default: command). */
  commandFields?: string[]
}

/** Compile once at load; invalid regex fails loud at startup (fail-closed). */
function compile(field: string, values: readonly string[]): RegExp[] {
  return values.map((source) => {
    try {
      return new RegExp(source)
    } catch (error) {
      throw new Error(`git-guard: invalid ${field} entry ${JSON.stringify(source)}: ${String(error)}`)
    }
  })
}

/**
 * Deny defaults — destructive or history-rewriting operations.
 * Notes:
 * - `push` force variants cover --force, -f, --force-with-lease(=…)?lease-only is
 *   safer but still rewriting; kept in deny per guardrail policy.
 * - `clean` requires -f to act, but deny any clean to stay strict.
 */
const DEFAULT_DENY: readonly string[] = [
  String.raw`\bgit\b[^|;&]*\breset\b[^|;&]*--hard\b`,
  String.raw`\bgit\b[^|;&]*\bclean\b`,
  String.raw`\bgit\b[^|;&]*\bpush\b[^|;&]*(--force(?!-with-lease)|\s-f\b)`,
  String.raw`\bgit\b[^|;&]*\bpush\b[^|;&]*--force-with-lease`,
  String.raw`\bgit\b[^|;&]*\bbranch\b[^|;&]*\s-D\b`,
  String.raw`\bgit\b[^|;&]*\bcheckout\b[^|;&]*\s--\s`,
  String.raw`\bgit\b[^|;&]*\brestore\b`,
  String.raw`\bgit\b[^|;&]*\breflog\b[^|;&]*\bexpire\b`,
  String.raw`\bgit\b[^|;&]*\bfilter-branch\b`,
  String.raw`\bgit\b[^|;&]*\bsubmodule\b[^|;&]*\bdeinit\b`,
]

/** Ask defaults — remote-affecting but negotiable. */
const DEFAULT_ASK: readonly string[] = [
  String.raw`\bgit\b[^|;&]*\bpush\b`,
  String.raw`\bgit\b[^|;&]*\bremote\b[^|;&]*\b(remove|rm|set-url)\b`,
  String.raw`\bgit\b[^|;&]*\btag\b[^|;&]*\s-d\b`,
]

/**
 * Hard-deny defaults (方案 B terminal guard) — the absolute red lines the
 * guard re-asserts AFTER the whole pre-execute waterfall: history rewriting
 * and workdropping. Force-push included: no listener ordering may resurrect it.
 */
const DEFAULT_HARD_DENY: readonly string[] = [
  String.raw`\bgit\b[^|;&]*\breset\b[^|;&]*--hard\b`,
  String.raw`\bgit\b[^|;&]*\bclean\b`,
  String.raw`\bgit\b[^|;&]*\bpush\b[^|;&]*(--force|\s-f\b)`,
  String.raw`\bgit\b[^|;&]*\bpush\b[^|;&]*--force-with-lease`,
  String.raw`\bgit\b[^|;&]*\bbranch\b[^|;&]*\s-D\b`,
  String.raw`\bgit\b[^|;&]*\bcheckout\b[^|;&]*\s--\s`,
  String.raw`\bgit\b[^|;&]*\brestore\b`,
  String.raw`\bgit\b[^|;&]*\bfilter-branch\b`,
]

export const Config: z<Config> = z.object({
  toolNames: z.array(String).default(['bash']),
  denyPatterns: z.array(String).default([...DEFAULT_DENY]),
  askPatterns: z.array(String).default([...DEFAULT_ASK]),
  hardDenyPatterns: z.array(String).default([...DEFAULT_HARD_DENY]),
  commandFields: z.array(String).default(['command']),
})

export function apply(ctx: Context, config: Config): void {
  const toolNames = new Set(config.toolNames ?? ['bash'])
  const deny = compile('denyPatterns', config.denyPatterns ?? DEFAULT_DENY)
  const ask = compile('askPatterns', config.askPatterns ?? DEFAULT_ASK)
  const hardDeny = compile('hardDenyPatterns', config.hardDenyPatterns ?? DEFAULT_HARD_DENY)
  const fields = config.commandFields ?? ['command']

  /** Extract the command strings from one execution's args; empty when N/A. */
  const commandOf = (exec: Readonly<ToolExecution>): string[] => {
    if (!toolNames.has(exec.name)) return []
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    return fields
      .map((field) => args[field])
      .filter((value): value is string => typeof value === 'string')
  }

  // 方案 B：deny-only 终审 guard —— 整个 pre-execute 瀑布之后同步执行，
  // 任何 listener 的 allow 决策都无法复活这里的拒绝。
  ctx.tools.guard((exec) => {
    for (const command of commandOf(exec)) {
      for (const pattern of hardDeny) {
        if (pattern.test(command)) {
          return `git-guard(终审): 命令命中绝对红线（${pattern.source}），已被永久拒绝，任何审批或插件放行均无效。命令: ${command}`
        }
      }
    }
    return undefined
  })

  // 加载探针：插件成功加载即注册此工具；排查完毕后移除。
  ctx.tools.register(defineTool({
    name: 'git_guard_status',
    description: 'git-guard load probe. Returns active rule counts.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loaded: { type: 'boolean' },
          denyRules: { type: 'number' },
          askRules: { type: 'number' },
          hardDenyRules: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `git-guard loaded=${value.loaded} deny=${value.denyRules} ask=${value.askRules} hardDeny=${value.hardDenyRules}` }],
    },
    execute() {
      return Promise.resolve({ loaded: true, denyRules: deny.length, askRules: ask.length, hardDenyRules: hardDeny.length })
    },
  }))

  // 方案 A：pre-execute 瀑布门禁 —— deny 直接拒绝，ask 走审批弹窗。
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const commands = commandOf(exec)
    if (commands.length === 0) return next()

    for (const command of commands) {
      for (const pattern of deny) {
        if (pattern.test(command)) {
          return { kind: 'deny', reason: `git-guard: 命令命中禁止规则（${pattern.source}），未执行。破坏性 git 操作不允许直接运行；如确有必要请人工在终端执行。命令: ${command}` }
        }
      }
    }
    for (const command of commands) {
      for (const pattern of ask) {
        if (pattern.test(command)) {
          return { kind: 'ask', reason: `git-guard: 命令影响远端（${pattern.source}），需要人工确认。命令: ${command}` }
        }
      }
    }
    return next()
  })
}
