/**
 * TAPD inspector tool: query defect tickets for the incident context leg.
 *
 * One JSON-Schema tool with two modes, mirroring the sibling inspectors:
 * omitting `id` lists bugs by filter (time window / status / severity /
 * owner); providing `id` fetches the full ticket (description, resolution,
 * fixer — the fields that tell whether a symptom is a known defect).
 *
 * Evidence envelope discipline matches the other legs: TAPD errors (401/403
 * permission denials in the body envelope) come back as `confidence: 0`
 * error evidence with the original info text — never fabricated tickets.
 *
 * @module @dsh-sentry/tool-tapd-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type { TapdBug, TapdComment } from '@dsh-sentry/service-tapd'

export const name = 'tool-tapd-inspector'

export const inject = ['tools', 'tapd']

export interface Config {
  /** Env label fallback when the assembly files are unreadable; TAPD itself is platform-level, matrix assemblies omit it. */
  env?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；TAPD 平台级，矩阵装配不设置'),
})

const SOURCE = 'tapd-inspector'
const TYPE = 'defect'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strip comment HTML (<br> → newline) for the evidence envelope. */
export function commentText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim()
}

/** Strip fields an incident reader doesn't need before the envelope. */
export function toTicketRow(bug: TapdBug): Record<string, unknown> {
  return {
    id: bug.id,
    title: bug.title,
    status: bug.status,
    severity: bug.severity,
    priority: bug.priority,
    current_owner: bug.current_owner,
    reporter: bug.reporter,
    created: bug.created,
    modified: bug.modified,
    ...(bug.description !== undefined ? { description: bug.description } : {}),
    ...(bug.resolution !== undefined ? { resolution: bug.resolution } : {}),
    ...(bug.fixer !== undefined ? { fixer: bug.fixer } : {}),
    ...(bug.deadline !== undefined ? { deadline: bug.deadline } : {}),
  }
}

export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

  ctx.tools.register(defineTool({
    name: 'sentry_query_tapd',
    description:
      '查询 TAPD 缺陷单（缺陷单是排障的背景证据：已知缺陷 × 现象对账）。'
      + ' 省略 id 时按过滤条件列缺陷（默认最近 30 条，按修改时间倒序）；'
      + ' 提供 id 时返回单条完整详情（含描述、解决方案、修复人）。'
      + ' 权限不足时返回 confidence 0 的错误证据。',
    parameters: {
      id: { type: 'string', description: '缺陷单 id；提供时返回完整详情，忽略其它过滤参数' },
      status: { type: 'string', description: '按状态过滤（如 new / in_progress / resolved；取值见项目状态流）' },
      severity: { type: 'string', description: '按严重度过滤（TAPD 值如 High / Middle / Low）' },
      owner: { type: 'string', description: '按当前处理人过滤（TAPD 用户名）' },
      title: { type: 'string', description: '按标题模糊匹配' },
      createdStart: { type: 'string', description: '创建时间起（YYYY-MM-DD 或完整时间）' },
      createdEnd: { type: 'string', description: '创建时间止' },
      limit: { type: 'number', default: 30, description: '返回条数上限，默认 30，最大 200' },
      orderBy: { type: 'string', description: "排序，如 'priority desc'（按优先级）或 'created desc'；默认 modified desc" },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
        try {
          if (args.id !== undefined) {
            const bug = await ctx.tapd.fetchBug(args.id)
            // 评论（测试反馈/流转备注）与详情并行拉取；评论失败不拖垮详情
            const comments = await ctx.tapd.listComments(args.id)
              .then((rows: TapdComment[]) => rows.map((c) => ({
                author: c.author, created: c.created, text: commentText(c.description),
              })))
              .catch((error: unknown) => [{ error: errorMessage(error) }])
            return buildEvidence({
              source: SOURCE,
              type: TYPE,
              data: { env: liveEnv(), mode: 'detail', ticket: toTicketRow(bug), comments },
              summary: `TAPD 缺陷 ${bug.id}: ${bug.title}（${bug.status}，评论 ${Array.isArray(comments) ? comments.length : 0} 条）`,
              confidence: 0.9,
              refs: [`env:${liveEnv()}:tapd`, `tapd:bug:${bug.id}`],
            }) as unknown as JsonValue
          }
          const bugs = await ctx.tapd.listBugs({
            status: args.status,
            severity: args.severity,
            owner: args.owner,
            reporter: undefined,
            title: args.title,
            createdStart: args.createdStart,
            createdEnd: args.createdEnd,
            limit: args.limit ?? 30,
            orderBy: args.orderBy,
          })
          const tickets = bugs.map(toTicketRow)
          return buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: liveEnv(), mode: 'list', count: tickets.length, tickets },
            summary: `env=${liveEnv()} TAPD 缺陷列表：${tickets.length} 条`
              + `${args.severity ? ` severity=${args.severity}` : ''}${args.status ? ` status=${args.status}` : ''}`
              + `${args.createdStart ? ` created>=${args.createdStart}` : ''}`,
            confidence: 0.9,
            refs: [`env:${liveEnv()}:tapd`],
          }) as unknown as JsonValue
        } catch (error) {
          return buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: liveEnv(), error: errorMessage(error) },
            summary: `TAPD 查询失败: ${errorMessage(error).slice(0, 120)}`,
            confidence: 0,
            refs: [`env:${liveEnv()}:tapd`],
          }) as unknown as JsonValue
        }
      },
    }),
  )
}
