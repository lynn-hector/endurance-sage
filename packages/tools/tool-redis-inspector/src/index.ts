/**
 * Redis inspector tool: query one Redis key's value, TTL, and type through
 * the dbx platform, returning the decoded value in the unified evidence
 * envelope.
 *
 * Port of the original `skills/redis-inspector` (SKILL.md +
 * scripts/inspect.py). The CLI flags collapse into one JSON-Schema tool; the
 * wire call (`_query_value`, base64 `keyRaw`) lives in `service-dbx` as
 * {@link DbxService.redisGetValue}, and the disk-cache compatibility shim
 * (`_load_connection`'s root-level `connection_id` fallback) is gone — the
 * in-memory cache only ever holds the current structure.
 *
 * Deliberate normalizations (recorded drift):
 * - the original `_build_evidence` returned bare evidence fields without the
 *   `{ evidence: ... }` envelope mandated by `templates/evidence-format.md`;
 *   this tool emits the standard envelope via `@dsh-sentry/evidence`;
 * - the original `--dry-run` printed raw non-evidence JSON; this tool returns
 *   an evidence envelope marked `dry_run: true`;
 * - missing endpoint/password crashed the original with RuntimeError; that
 *   guard now lives in `service-dbx` (`dbx endpoint 或登录密码缺失…`) and
 *   surfaces here as an error evidence envelope (confidence 0).
 *
 * @module @dsh-sentry/tool-redis-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type {} from '@dsh-sentry/service-dbx'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-redis-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'dbx']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
  /** Default Redis db index (the original `redis.db` config field, default 0). */
  db?: number
  /** Preferred redis connection id (the original `redis.connection_id`). */
  connectionId?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
  db: z.number().step(1).min(0).default(0).description('默认 Redis db 索引（原 redis.db，默认 0）'),
  connectionId: z.string().description('优先使用的 redis 连接 ID（原 redis.connection_id）'),
})

const SOURCE = 'redis-inspector'
const TYPE = 'redis'
const CONN_TYPE = 'redis'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Port of `_decode_content`: base64-decode `content.raw_base64` with
 * replacement on undecodable bytes, then return parsed JSON only when the
 * text is an object/array (scalars stay text, exactly like the original's
 * `isinstance(parsed, (dict, list))`).
 */
export function decodeContent(content: Record<string, unknown> | undefined): {
  value: unknown
  encoding: string
} {
  if (content === undefined) return { value: null, encoding: '' }
  const rawB64 = content['raw_base64']
  const encoding = (content['encoding'] as string | undefined) ?? 'utf8'
  if (typeof rawB64 !== 'string' || rawB64.length === 0) return { value: null, encoding }

  let text: string
  try {
    text = new TextDecoder(encoding || 'utf8', { fatal: false }).decode(Buffer.from(rawB64, 'base64'))
  } catch (error) {
    return { value: `<decode error: ${errorMessage(error)}>`, encoding }
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return { value: parsed, encoding }
  } catch {
    // Not JSON: fall through to plain text, like the original.
  }
  return { value: text, encoding }
}

/** Register the Redis query tool. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'
  const refs = (): string[] => [`dbx:${ctx.dbx.endpoint}`, `env:${liveEnv()}:redis`]

  ctx.tools.register(defineTool({
    name: 'sentry_query_redis',
    description:
      'Query one Redis key through the dbx platform: value (base64-decoded, JSON-parsed when possible), '
      + 'TTL, and type. Read-only. Session and connection discovery are handled automatically.',
    parameters: {
      key: { type: 'string', required: true, description: 'The Redis key (raw string).' },
      db: { type: 'number', description: 'Redis db index. Defaults to the plugin configuration.' },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const db = args.db ?? config.db ?? 0
      const preferredId = config.connectionId
      // Original: cached connection wins over the configured preferred id;
      // with neither, the empty id falls through to auto-discovery inside the
      // fallback (Python `or` semantics).
      const startId = ctx.dbx.getCachedConnection(CONN_TYPE)?.id ?? preferredId ?? ''
      const keyRaw = Buffer.from(args.key, 'utf8').toString('base64')

      if (args.dryRun === true) {
        // Deviation (module doc): evidence envelope instead of raw JSON.
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            dry_run: true,
            url: `${ctx.dbx.endpoint}/api/redis/get-value`,
            headers: { cookie: 'dbx_session=...', 'content-type': 'application/json' },
            body: {
              connectionId: startId || '(auto-discover)',
              db,
              keyRaw,
            },
          },
          summary: `[dry-run] env=${liveEnv()} 构造 Redis 查询请求，未发送。`,
          confidence: 1.0,
          refs: refs(),
        }) as unknown as JsonValue
      }

      try {
        const { value: response, connectionId } = await ctx.dbx.runWithFallback(
          CONN_TYPE,
          startId,
          preferredId,
          id => ctx.dbx.redisGetValue(id, db, args.key),
        )

        const keyDisplay = response['key_display']
        const ttl = response['ttl']
        const redisType = response['redis_type']
        const content = asRecord(asRecord(response['data'])?.['content'])
        const { value: decodedValue, encoding: valueEncoding } = decodeContent(content)

        const summaryParts = [`Redis key \`${args.key}\` 查询完成`]
        if (redisType) summaryParts.push(`类型 ${String(redisType)}`)
        if (ttl !== undefined && ttl !== null) summaryParts.push(`TTL ${String(ttl)}s`)
        if (decodedValue !== null) summaryParts.push('value 已解码')

        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            key: args.key,
            key_display: keyDisplay ?? null,
            key_raw: response['key_raw'] ?? null,
            db,
            connection_id: connectionId,
            ttl: ttl ?? null,
            redis_type: redisType ?? null,
            value: decodedValue,
            value_encoding: valueEncoding,
            value_raw_base64: content?.['raw_base64'] ?? null,
            raw_response: response,
          },
          summary: summaryParts.join('，'),
          confidence: keyDisplay ? 0.95 : 0.5,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `Redis 查询失败: ${errorMessage(error)}`,
          refs: refs(),
        }) as unknown as JsonValue
      }
    },
  }))
}
