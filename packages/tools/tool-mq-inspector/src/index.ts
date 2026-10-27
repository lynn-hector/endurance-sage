/**
 * MQ inspector Tool Consumer.
 *
 * Depends only on the MqStore Definition. The console protocol, session
 * handshake and re-login choreography belong to the Provider. The tool
 * keeps the model-facing entrypoint (`sentry_query_mq`), the two modes
 * (list vs detail-by-msgId), time-argument normalization and the evidence
 * aggregation ported field-for-field from the original.
 *
 * Port of the original `skills/mq-inspector` (SKILL.md +
 * scripts/inspect.py). The CLI's two modes collapse into one JSON-Schema
 * tool: omitting `msgId` queries the message list (`--begin`/`--end`/
 * `--page-num`/`--page-size`/`--keyword`); providing it fetches the message
 * detail with consumption tracks. `--dry-run` is kept as a parameter.
 *
 * Deliberate deviations:
 * - `--env` disappeared: deployment-fixed, evidence metadata only;
 * - the JSESSIONID/XSRF-TOKEN disk cache is service-managed now (the
 *   checklist line "JSESSIONID 和 XSRF-TOKEN 是否已正确缓存" is moot);
 * - dry-run returns an evidence envelope (original printed raw JSON), and
 *   since the seam migration it carries the backend-neutral request
 *   (topic/time window or msgId + backend_ref) — console URLs and wire
 *   bodies no longer cross the seam;
 * - evidence refs change shape with the seam migration: the previous
 *   `rocketmq-console: <endpoint>` + `env:<endpoint>` pair (the second was
 *   a porting bug — an env ref carrying an endpoint) becomes
 *   `<backendRef>` + `env:<label>:mq`, matching the other evidence legs;
 *   list/detail evidence data gains `backend_ref`.
 *
 * @module @dsh-sentry/tool-mq-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import { parseTimeMs, type MqMessageDetailResult, type MqMessageListResult, type MqStore } from '@dsh-sentry/mq-store'
import type {} from '@dsh-sentry/mq-store'
import type {} from '@dsh-sentry/service-env-provider'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-mq-inspector'

/** The capability slots this plugin registers into. */
export const inject = ['tools', 'mqStore']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
})

const SOURCE = 'mq-inspector'
const TYPE = 'mq'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asEvidence(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * Port of the detail-mode branch of `_build_evidence`: consumed /
 * not-online / filtered consumer groups and the summary wording.
 */
export function detailEvidence(
  env: string,
  backendRef: string,
  topic: string,
  msgIdArg: string,
  result: MqMessageDetailResult,
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
      backend_ref: backendRef,
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
    refs: [backendRef, `env:${env}:mq`],
  }))
}

/**
 * Port of the list-mode branch of `_build_evidence`: pagination fields and
 * the summary wording（`返回 N 条，共 M 条，K 页`）.
 */
export function listEvidence(
  env: string,
  backendRef: string,
  args: {
    topic: string
    beginMs: number
    endMs: number
    pageNum: number
    pageSize: number
    keyword: string
  },
  result: MqMessageListResult,
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
      backend_ref: backendRef,
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
    refs: [backendRef, `env:${env}:mq`],
  }))
}

/** The store, env label and lease one call fixed at its start. */
interface CallProvider {
  env: string
  store: MqStore
  release: () => Promise<void>
}

/** Register the MQ query tool against the backend-neutral seam. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

  // Session-routed hosts resolve the Provider through the calling session's
  // binding; legacy hosts keep the global store and assembly env label.
  const routeStore = async (exec: ToolRunContext): Promise<CallProvider> => {
    const envProviders = ctx.get('envProviders')
    if (envProviders !== undefined) {
      const lease = await envProviders.forCall(exec)
      return { env: lease.env, store: lease.require('mqStore'), release: lease.release }
    }
    return { env: liveEnv(), store: ctx.mqStore, release: async () => {} }
  }

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
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeStore(exec)
        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
        const { env, store } = call
        const backendRef = store.backendRef
        const refs = (): string[] => [backendRef, `env:${env}:mq`]

        // Original defaults: end = now, begin = 1 hour ago.
        const endMs = parseTimeMs(args.end, Date.now())
        const beginMs = parseTimeMs(args.begin, endMs - 3_600_000)
        const pageNum = args.pageNum ?? 1
        const pageSize = args.pageSize ?? 10
        const keyword = args.keyword ?? ''

        if (args.dryRun === true) {
          // Backend-neutral request only: console URLs and wire bodies are
          // Provider internals (module doc records the drift).
          const request = args.msgId !== undefined
            ? { mode: 'detail' as const, topic: args.topic, msg_id: args.msgId }
            : {
              mode: 'list' as const,
              topic: args.topic,
              begin_ms: beginMs,
              end_ms: endMs,
              page_num: pageNum,
              page_size: pageSize,
              keyword,
            }
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env, dry_run: true, backend_ref: backendRef, request },
            summary: 'DRY-RUN：只构造请求，不发送',
            confidence: 0.5,
            refs: refs(),
          }))
        }

        if (args.msgId !== undefined) {
          const result = await store.queryMessageDetail({ topic: args.topic, msgId: args.msgId })
          return detailEvidence(env, backendRef, args.topic, args.msgId, result)
        }

        const result = await store.queryMessages({
          topic: args.topic, beginMs, endMs, pageNum, pageSize, keyword,
        })
        return listEvidence(env, backendRef, { topic: args.topic, beginMs, endMs, pageNum, pageSize, keyword }, result)
      } catch (error) {
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: call?.env ?? 'unknown',
            backend_ref: call?.store.backendRef ?? null,
            topic: args.topic,
            msg_id: args.msgId ?? null,
            error: errorMessage(error),
          },
          summary: `查询 RocketMQ 消息失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: call?.store.backendRef === undefined
            ? []
            : [call.store.backendRef, `env:${call.env}:mq`],
        }))
      } finally {
        await call?.release()
      }
    },
  }))
}
