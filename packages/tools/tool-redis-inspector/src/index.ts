/**
 * Redis inspector Tool Consumer.
 *
 * Depends only on the CacheStore Definition. The dbx platform protocol
 * (base64 `keyRaw` wire call), connection discovery, session refresh and
 * value decoding belong to the Provider; the tool receives an already
 * decoded neutral entry. The model-facing entrypoint (`sentry_query_redis`),
 * the default db index and the evidence envelope are kept.
 *
 * Port of the original `skills/redis-inspector` (SKILL.md +
 * scripts/inspect.py).
 *
 * Deliberate normalizations (recorded drift):
 * - the original `_build_evidence` returned bare evidence fields without the
 *   `{ evidence: ... }` envelope mandated by `templates/evidence-format.md`;
 *   this tool emits the standard envelope via `@dsh-sentry/evidence`;
 * - the original `--dry-run` printed the raw HTTP request (URL, cookie
 *   header, base64 body); this tool returns an evidence envelope marked
 *   `dry_run: true` with the backend-neutral request only (key + db +
 *   backend_ref) — wire details no longer cross the seam;
 * - missing endpoint/password crashed the original with RuntimeError; that
 *   guard now lives in the Provider (`dbx endpoint 或登录密码缺失…`) and
 *   surfaces here as an error evidence envelope (confidence 0).
 *
 * @module @dsh-sentry/tool-redis-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type {} from '@dsh-sentry/cache-store'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-redis-inspector'

/** The capability slots this plugin registers into. */
export const inject = ['tools', 'cacheStore']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
  /** Default Redis db index (the original `redis.db` config field, default 0). Caller intent, not Provider configuration. */
  db?: number
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
  db: z.number().step(1).min(0).default(0).description('默认 Redis db 索引（原 redis.db，默认 0）'),
})

const SOURCE = 'redis-inspector'
const TYPE = 'redis'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register the Redis query tool against the backend-neutral seam. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

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
      const store = ctx.cacheStore
      const backendRef = store.backendRef
      const refs = (): string[] => [backendRef, `env:${liveEnv()}:redis`]
      const db = args.db ?? config.db ?? 0

      if (args.dryRun === true) {
        // Deviation (module doc): neutral evidence envelope instead of the raw
        // HTTP request the script printed.
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            dry_run: true,
            backend_ref: backendRef,
            key: args.key,
            db,
          },
          summary: `[dry-run] env=${liveEnv()} 构造 Redis 查询请求，未发送。`,
          confidence: 1.0,
          refs: refs(),
        }) as unknown as JsonValue
      }

      try {
        const entry = await store.getValue({ key: args.key, db })

        const summaryParts = [`Redis key \`${args.key}\` 查询完成`]
        if (entry.redisType) summaryParts.push(`类型 ${String(entry.redisType)}`)
        if (entry.ttl !== undefined && entry.ttl !== null) summaryParts.push(`TTL ${String(entry.ttl)}s`)
        if (entry.value !== null) summaryParts.push('value 已解码')

        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            backend_ref: backendRef,
            key: args.key,
            key_display: entry.keyDisplay ?? null,
            key_raw: entry.keyRaw ?? null,
            db,
            connection_id: entry.connectionId,
            ttl: entry.ttl ?? null,
            redis_type: entry.redisType ?? null,
            value: entry.value,
            value_encoding: entry.valueEncoding,
            value_raw_base64: entry.valueRawBase64 ?? null,
            raw_response: entry.raw,
          },
          summary: summaryParts.join('，'),
          confidence: entry.keyDisplay ? 0.95 : 0.5,
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
