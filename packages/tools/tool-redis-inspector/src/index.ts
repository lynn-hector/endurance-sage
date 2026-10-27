/**
 * Redis inspector Tool Consumer.
 *
 * Depends only on the CacheStore Definition and the Session environment
 * Provider router: the Provider for one call is the calling session's
 * bound environment, leased through `envProviders`. Backend authentication
 * and wire decoding stay in the Provider.
 *
 * @module @dsh-sentry/tool-redis-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import type { CacheStore } from '@dsh-sentry/cache-store'
import type {} from '@dsh-sentry/service-env-provider'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-redis-inspector'

/** ToolRuntime and the Session Provider router are required. */
export const inject = ['tools', 'envProviders']

export interface Config {
  /** Default Redis db index. */
  db?: number
}

export const Config: z<Config> = z.object({
  db: z.number().step(1).min(0).default(0).description('默认 Redis db 索引'),
})

const SOURCE = 'redis-inspector'
const TYPE = 'redis'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface CallProvider {
  env: string
  store: CacheStore
  release: () => Promise<void>
}

/** Register the Redis query tool against the backend-neutral seam. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sentry_query_redis',
    description:
      'Query one Redis key through the dbx platform: value (base64-decoded, JSON-parsed when possible), '
      + 'TTL, and type. Read-only. Session and connection discovery are handled automatically.',
    parameters: {
      key: { type: 'string', required: true, description: 'Redis key (raw string).' },
      db: { type: 'number', description: 'Redis db index. Defaults to the plugin configuration.' },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        // The Provider is the calling session's bound environment: env,
        // backend identity and lease are fixed before the first backend await.
        const lease = await ctx.envProviders.forCall(exec)
        const resolved: CallProvider = { env: lease.env, store: lease.require('cacheStore'), release: lease.release }
        call = resolved

        const { env, store } = resolved
        const backendRef = store.backendRef
        const refs = [backendRef, `env:${env}:redis`]
        const db = args.db ?? config.db ?? 0

        if (args.dryRun === true) {
          return buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env, dry_run: true, backend_ref: backendRef, key: args.key, db },
            summary: `[dry-run] env=${env} 构造 Redis 查询请求，未发送。`,
            confidence: 1.0,
            refs,
          }) as unknown as JsonValue
        }

        const entry = await store.getValue({ key: args.key, db })
        const summaryParts = [`Redis key \`${args.key}\` 查询完成`]
        if (entry.redisType) summaryParts.push(`类型 ${String(entry.redisType)}`)
        if (entry.ttl !== undefined && entry.ttl !== null) summaryParts.push(`TTL ${String(entry.ttl)}s`)
        if (entry.value !== null) summaryParts.push('value 已解码')

        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
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
          refs,
        }) as unknown as JsonValue
      } catch (error) {
        const backendRef = call?.store.backendRef
        return buildEvidenceError({
          source: SOURCE,
          type: TYPE,
          error: errorMessage(error),
          summary: `Redis 查询失败: ${errorMessage(error)}`,
          refs: backendRef === undefined ? [] : [backendRef, `env:${call?.env ?? 'unknown'}:redis`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
      }
    },
  }))
}
