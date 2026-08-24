/**
 * MQ inspector tool: query a topic's message list, or one message's detail
 * and consumption tracks, via the RocketMQ Console — in the unified
 * evidence envelope.
 *
 * Port of the original `skills/mq-inspector` (SKILL.md +
 * scripts/inspect.py). The CLI's two modes collapse into one JSON-Schema
 * tool: omitting `msgId` queries the message list (`--begin`/`--end`/
 * `--page-num`/`--page-size`/`--keyword`); providing it fetches the message
 * detail with consumption tracks. `--dry-run` is kept as a parameter.
 *
 * The original already printed the standard `{"evidence": ...}` envelope,
 * so no envelope normalization was needed — the aggregation in
 * `_build_evidence` (summary wording, consumed/not-online/filtered group
 * extraction, `confidence 0.95 if status == 0 else 0.5`) is ported
 * field-for-field.
 *
 * Deliberate deviations:
 * - `--env` disappeared: deployment-fixed, evidence metadata only;
 * - the JSESSIONID/XSRF-TOKEN disk cache is service-managed now (the
 *   checklist line "JSESSIONID 和 XSRF-TOKEN 是否已正确缓存" is moot);
 * - dry-run returns an evidence envelope (original printed raw JSON).
 *
 * @module @dsh-sentry/tool-mq-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import { RocketMqService } from '@dsh-sentry/service-rocketmq'
import type {} from '@dsh-sentry/service-rocketmq'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-mq-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'rocketmq']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Environment label (`local` / `staging` / `production`); evidence metadata only. */
  env: string
}

export const Config: z<Config> = z.object({
  env: z.string().required().description('环境标识（local/staging/production），仅作为 evidence 元数据'),
})

const SOURCE = 'mq-inspector'
const TYPE = 'mq'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asEvidence(value: unknown): JsonValue {
  return value as JsonValue
}

function refs(ctx: Context): string[] {
  return [
    `rocketmq-console: ${ctx.rocketmq.endpoint}`,
    `env:${ctx.rocketmq.endpoint}`,
  ]
}

/**
 * Port of the detail-mode branch of `_build_evidence`: consumed /
 * not-online / filtered consumer groups and the summary wording.
 */
export function detailEvidence(
  env: string,
  topic: string,
  msgIdArg: string,
  result: {
    status: unknown
    errMsg: string | null
    messageView: Record<string, unknown>
    messageTrackList: Record<string, unknown>[]
    raw: Record<string, unknown>
  },
): JsonValue {
  const consumedGroups: unknown[] = []
  const notOnlineGroups: unknown[] = []
  const filteredGroups: unknown[] = []
  for (const track of result.messageTrackList) {
    const group = track['consumerGroup']
    const trackType = track['trackType']
    if (trackType === 'CONSUMED') consumedGroups.push(group)
    else if (trackType === 'NOT_ONLINE') notOnlineGroups.push(group)
    else if (trackType === 'CONSUMED_BUT_FILTERED') filteredGroups.push(group)
  }

  const msgId = typeof result.messageView['msgId'] === 'string'
    ? result.messageView['msgId'] as string
    : msgIdArg

  let summary = `消息 \`${msgId}\` 详情查询完成`
  const join = (values: unknown[]): string =>
    values.filter((v): v is string => typeof v === 'string').join(', ')
  if (consumedGroups.length > 0) summary += `，已消费组: ${join(consumedGroups)}`
  if (notOnlineGroups.length > 0) summary += `，未在线组: ${join(notOnlineGroups)}`
  if (filteredGroups.length > 0) summary += `，已过滤组: ${join(filteredGroups)}`
  if (result.errMsg) summary += `，错误信息: ${result.errMsg}`

  return asEvidence(buildEvidence({
    source: SOURCE,
    type: TYPE,
    data: {
      env,
      topic,
      msg_id: msgIdArg,
      status: result.status,
      err_msg: result.errMsg,
      message_view: result.messageView,
      message_track_list: result.messageTrackList,
      consumed_groups: consumedGroups,
      not_online_groups: notOnlineGroups,
      filtered_groups: filteredGroups,
      raw_response: result.raw,
    },
    summary,
    confidence: result.status === 0 ? 0.95 : 0.5,
    refs: [`msg:${topic}:${msgIdArg}`],
  }))
}

/**
 * Port of the list-mode branch of `_build_evidence`: pagination fields and
 * the summary wording（`返回 N 条，共 M 条，K 页`）.
 */
export function listEvidence(
  env: string,
  args: {
    topic: string
    beginMs: number
    endMs: number
    pageNum: number
    pageSize: number
    keyword: string
  },
  result: {
    status: unknown
    errMsg: string | null
    taskId: unknown
    truncated: boolean
    scanned: number
    totalElements: number | null
    totalPages: number | null
    messages: Record<string, unknown>[]
    raw: Record<string, unknown>
  },
): JsonValue {
  const rowCount = result.messages.length
  let summary = `topic \`${args.topic}\` 查询完成，返回 ${rowCount} 条`
  if (result.totalElements !== null) summary += `，共 ${result.totalElements} 条`
  if (result.totalPages !== null) summary += `，${result.totalPages} 页`
  if (result.errMsg) summary += `，错误信息: ${result.errMsg}`

  return asEvidence(buildEvidence({
    source: SOURCE,
    type: TYPE,
    data: {
      env,
      topic: args.topic,
      begin: String(args.beginMs),
      end: String(args.endMs),
      begin_ms: args.beginMs,
      end_ms: args.endMs,
      page_num: args.pageNum,
      page_size: args.pageSize,
      keyword: args.keyword,
      status: result.status,
      err_msg: result.errMsg,
      task_id: result.taskId,
      truncated: result.truncated,
      scanned: result.scanned,
      total_elements: result.totalElements,
      total_pages: result.totalPages,
      messages: result.messages,
      row_count: rowCount,
      raw_response: result.raw,
    },
    summary,
    confidence: result.status === 0 ? 0.95 : 0.5,
    refs: [`topic:${args.topic}`],
  }))
}

/** Register the MQ query tool. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sentry_query_mq',
    description:
      'Query RocketMQ messages via the console: omit msgId to page through a topic\'s message list '
      + '(time range + keyword), or provide msgId to fetch one message\'s body and consumption '
      + 'tracks (which consumer groups consumed / missed / filtered it). Read-only.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Topic name.' },
      msgId: { type: 'string', description: 'Message ID; when set, queries that message\'s detail and tracks instead of the list.' },
      begin: { type: 'string', description: 'List mode: range start, millisecond epoch or ISO8601. Defaults to 1 hour ago.' },
      end: { type: 'string', description: 'List mode: range end, millisecond epoch or ISO8601. Defaults to now.' },
      pageNum: { type: 'integer', default: 1, description: 'List mode: page number, default 1.' },
      pageSize: { type: 'integer', default: 10, description: 'List mode: page size, default 10.' },
      keyword: { type: 'string', description: 'List mode: message keyword filter.' },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      // Original defaults: end = now, begin = 1 hour ago.
      const endMs = RocketMqService.parseTimeMs(args.end, Date.now())
      const beginMs = RocketMqService.parseTimeMs(args.begin, endMs - 3_600_000)
      const pageNum = args.pageNum ?? 1
      const pageSize = args.pageSize ?? 10
      const keyword = args.keyword ?? ''

      try {
        if (args.dryRun === true) {
          const request = args.msgId !== undefined
            ? ctx.rocketmq.buildDetailRequest(args.topic, args.msgId)
            : ctx.rocketmq.buildListRequest({
              topic: args.topic, beginMs, endMs, pageNum, pageSize, keyword,
            })
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: config.env, dry_run: true, request },
            summary: 'DRY-RUN：只构造请求，不发送',
            confidence: 0.5,
            refs: refs(ctx),
          }))
        }

        if (args.msgId !== undefined) {
          const result = await ctx.rocketmq.queryMessageDetail(args.topic, args.msgId)
          return detailEvidence(config.env, args.topic, args.msgId, result)
        }

        const result = await ctx.rocketmq.queryMessages({
          topic: args.topic, beginMs, endMs, pageNum, pageSize, keyword,
        })
        return listEvidence(config.env, { topic: args.topic, beginMs, endMs, pageNum, pageSize, keyword }, result)
      } catch (error) {
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: config.env,
            topic: args.topic,
            msg_id: args.msgId ?? null,
            error: errorMessage(error),
          },
          summary: `查询 RocketMQ 消息失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: refs(ctx),
        }))
      }
    },
  }))
}
