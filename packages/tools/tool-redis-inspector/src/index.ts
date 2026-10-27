/**
 * Redis inspector Tool Consumer.
 *
 * Session-routed hosts resolve a leased Provider through envProviders. Legacy
 * hosts without that module keep using the global CacheStore and assembly env
 * label. Backend authentication and wire decoding stay in the Provider.
 *
 * @module @dsh-sentry/tool-redis-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence, buildEvidenceError } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import type { CacheStore } from '@dsh-sentry/cache-store'
import type {} from '@dsh-sentry/service-env-provider'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-redis-inspector'

/** ToolRuntime is required; Provider seams are selected per call. */
export const inject = ['tools']

export interface Config {
  /** Legacy env label fallback when no Session Provider router is mounted. */
  env?: string
  /** Default Redis db index. */
  db?: number
}

export const Config: z<Config> = z.object({
  env: z.string().description('旧全局装配的环境标签回退值'),
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
  const legacyEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

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
        const envProviders = ctx.get('envProviders')
        let resolved: CallProvider
        if (envProviders !== undefined) {
          const lease = await envProviders.forCall(exec)
          resolved = { env: lease.env, store: lease.require('cacheStore'), release: lease.release }
        } else {
          const store = ctx.get('cacheStore')
          if (store === undefined) throw new Error('Redis Provider 未加载，且 Session 环境 Provider 不可用')
          resolved = { env: legacyEnv(), store, release: async () => {} }
        }
        call = resolved

        // Env, backend identity and Provider are fixed before the first await
        // on backend I/O. A concurrent Session switch affects only later calls.
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
