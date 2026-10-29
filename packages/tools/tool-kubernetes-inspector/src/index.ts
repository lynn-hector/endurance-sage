/**
 * Kubernetes inspector tools: read-only pod / log / event / resource views
 * that follow the calling session's bound environment.
 *
 * The heavy lifting stays behind `service-kubernetes` (the MCP gateway
 * bridge); this package only curates the model surface: four tools instead
 * of the gateway's fourteen, no `context` parameter anywhere (the Provider
 * pins the session environment's cluster into every call), and the standard
 * evidence envelope (`source: kubernetes-inspector`, `env` marker, provider
 * `backend_ref`) so K8s findings cross-verify with logs/traces/metrics
 * instead of living outside the evidence chain like raw MCP mounts would.
 *
 * Tool set (deliberate curation):
 * - `sentry_query_k8s_pods` — pod rows of a namespace, or one full Pod;
 * - `sentry_read_k8s_pod_logs` — container logs (incl. previous instance);
 * - `sentry_list_k8s_events` — warnings/errors/state changes;
 * - `sentry_query_k8s_resource` — any object by apiVersion/kind (+list).
 * Mutating gateway tools do not exist server-side (`read_only`); nothing
 * here could write even if asked.
 *
 * @module @dsh-sentry/tool-kubernetes-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import type { McpToolResult } from '@dsh-sentry/service-kubernetes'
import type {} from '@dsh-sentry/service-env-provider'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-kubernetes-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'envProviders']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {}

export const Config: z<Config> = z.object({})

const SOURCE = 'kubernetes-inspector'
const TYPE = 'kubernetes'

/**
 * The Provider identity one execution snapshots at its start: every
 * evidence branch of that call reports the same backend and cluster even if
 * a Session switch rebinds the route mid-call.
 */
interface KubernetesIdentity {
  context: string
  namespace: string
  backendRef: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Page-size ceiling for row-returning tools — keeps evidence envelopes bounded. */
const MAX_LIMIT = 200

function clampLimit(value: number | undefined, fallback: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.trunc(raw), MAX_LIMIT)
}

/** Shared list-shape extraction from a gateway tool result. */
function listRows(result: McpToolResult): {
  items: unknown[]
  continueToken: string | null
  remainingItemCount: number | null
} {
  const structured = result.structured ?? {}
  const items = Array.isArray(structured['items']) ? structured['items'] : []
  const continueToken = typeof structured['continue'] === 'string' ? structured['continue'] : null
  const remaining = structured['remainingItemCount']
  return {
    items,
    continueToken,
    remainingItemCount: typeof remaining === 'number' ? remaining : null,
  }
}

/** Register the four Kubernetes view tools. */
export function apply(ctx: Context, _config: Config): void {
  // The Provider, env label and lease one call fixed at its start, typed
  // through the Cordis slot — tools never bind the Provider class itself.
  interface CallProvider {
    env: string
    store: Context['kubernetes']
    release: () => Promise<void>
  }

  const routeService = async (exec: ToolRunContext): Promise<CallProvider> => {
    const lease = await ctx.envProviders.forCall(exec)
    return { env: lease.env, store: lease.require('kubernetes'), release: lease.release }
  }

  ctx.tools.register(defineTool({
    name: 'sentry_query_k8s_pods',
    description:
      'Inspect Kubernetes pods of the current session environment. Default: pod rows of the business namespace '
      + '(name, ready, status, restarts, age, node, labels). With `pod`: one full Pod object (container statuses, '
      + 'images, node placement). Read-only; the cluster follows the session environment, no context parameter.',
    parameters: {
      pod: { type: 'string', description: 'Pod name: fetches the full Pod object. Omit to list the namespace pods.' },
      namespace: { type: 'string', description: 'Kubernetes namespace; defaults to the environment business namespace.' },
      labelSelector: { type: 'string', description: "Label selector, e.g. 'app.kubernetes.io/name=commctl-config'." },
      fieldSelector: { type: 'string', description: "Field selector, e.g. 'status.phase=Failed'." },
      limit: { type: 'number', default: 100, description: 'Max rows (1-200); more may exist — see remaining_item_count/continue.' },
      continueToken: { type: 'string', description: 'Continuation token from a previous page to fetch the next page.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeService(exec)
        const { env, store } = call
        const identity: KubernetesIdentity = { context: store.context, namespace: store.namespace, backendRef: store.backendRef }
        const refs = (): string[] => [identity.backendRef, `env:${env}:kubernetes`]
        const namespace = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : store.namespace
        const pod = typeof args.pod === 'string' && args.pod.length > 0 ? args.pod : undefined

        if (pod !== undefined) {
          const result = await store.getPod(pod, namespace)
          const podObject = result.structured ?? {}
          const status = (podObject['status'] as Record<string, unknown> | undefined)?.['phase']
          return buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: {
              env,
              backend_ref: identity.backendRef,
              context: identity.context,
              namespace,
              mode: 'pod_detail' as const,
              pod,
              phase: typeof status === 'string' ? status : null,
              object: podObject,
            },
            summary: `Pod ${pod}@${identity.context}/${namespace} 当前 phase: ${typeof status === 'string' ? status : '未知'}`,
            confidence: 0.95,
            refs: refs(),
          }) as unknown as JsonValue
        }

        const result = await store.listPods({
          namespace,
          ...(args.labelSelector !== undefined ? { labelSelector: args.labelSelector } : {}),
          ...(args.fieldSelector !== undefined ? { fieldSelector: args.fieldSelector } : {}),
          limit: clampLimit(args.limit, 100),
          ...(args.continueToken !== undefined ? { continue: args.continueToken } : {}),
        })
        const rows = listRows(result)
        const notRunning = rows.items.filter(item => isRow(item) && item['Status'] !== 'Running')
        let summary = `集群 ${identity.context} 命名空间 ${namespace} 共 ${rows.items.length} 个 Pod`
        if (rows.remainingItemCount !== null) summary += `，其后还有约 ${rows.remainingItemCount} 个（用 continueToken 翻页）`
        if (notRunning.length > 0) summary += `，其中 ${notRunning.length} 个非 Running`
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: identity.backendRef,
            context: identity.context,
            namespace,
            mode: 'pod_list' as const,
            item_count: rows.items.length,
            items: rows.items,
            continue: rows.continueToken,
            remaining_item_count: rows.remainingItemCount,
          },
          summary,
          confidence: 0.95,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return podListError(args, call, errorMessage(error))
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_read_k8s_pod_logs',
    description:
      'Read the container logs of one Kubernetes pod in the current session environment. Use `previous: true` for '
      + 'the last terminated instance (post-crash logs), `container` to pick a sidecar. Read-only; bounded by `tail`.',
    parameters: {
      pod: { type: 'string', required: true, description: 'Pod name (get candidates via sentry_query_k8s_pods).' },
      namespace: { type: 'string', description: 'Kubernetes namespace; defaults to the environment business namespace.' },
      container: { type: 'string', description: 'Container name; defaults to the pod default container.' },
      tail: { type: 'number', default: 100, description: 'Tail lines to retrieve.' },
      previous: { type: 'boolean', default: false, description: 'Return the previous terminated container logs.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeService(exec)
        const { env, store } = call
        const identity: KubernetesIdentity = { context: store.context, namespace: store.namespace, backendRef: store.backendRef }
        const refs = (): string[] => [identity.backendRef, `env:${env}:kubernetes`]
        const namespace = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : store.namespace
        const pod = args.pod as string
        const tail = Math.min(Math.max(Number(args.tail) || 100, 1), 2000)

        const logs = await store.getPodLogs(pod, {
          namespace,
          ...(args.container !== undefined ? { container: args.container } : {}),
          tail,
          ...(args.previous === true ? { previous: true } : {}),
        })
        const lines = logs.split('\n').filter(line => line.length > 0)
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: identity.backendRef,
            context: identity.context,
            namespace,
            mode: 'pod_logs' as const,
            pod,
            container: args.container ?? null,
            previous: args.previous === true,
            tail,
            line_count: lines.length,
            logs,
          },
          summary: `Pod ${pod}@${identity.context}/${namespace}${args.previous === true ? ' 上一个实例' : ''} 日志末尾 ${lines.length} 行`,
          confidence: 0.95,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        const message = errorMessage(error)
        const env = call?.env ?? 'unknown'
        const fallback: KubernetesIdentity = call === undefined
          ? { context: '', namespace: '', backendRef: 'kubernetes:unresolved' }
          : { context: call.store.context, namespace: call.store.namespace, backendRef: call.store.backendRef }
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: fallback.backendRef,
            context: fallback.context,
            namespace: typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : fallback.namespace,
            mode: 'pod_logs' as const,
            pod: args.pod,
            container: args.container ?? null,
            previous: args.previous === true,
            line_count: 0,
            logs: '',
            error: message,
          },
          summary: `Pod ${String(args.pod)} 日志读取失败: ${message}`,
          confidence: 0,
          refs: [fallback.backendRef, `env:${env}:kubernetes`],
        }) as unknown as JsonValue
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_list_k8s_events',
    description:
      'List Kubernetes events (warnings, errors, state changes) of the current session environment. Default: all '
      + "namespaces of the session cluster — the blast-radius view. Provide `namespace` to scope. Read-only.",
    parameters: {
      namespace: { type: 'string', description: 'Namespace to scope events; omit for the whole cluster.' },
      fieldSelector: { type: 'string', description: "Field selector, e.g. 'type=Warning' or 'involvedObject.name=<pod>'." },
      limit: { type: 'number', default: 100, description: 'Max events (1-200); more may exist — see remaining_item_count/continue.' },
      continueToken: { type: 'string', description: 'Continuation token from a previous page to fetch the next page.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeService(exec)
        const { env, store } = call
        const identity: KubernetesIdentity = { context: store.context, namespace: store.namespace, backendRef: store.backendRef }
        const refs = (): string[] => [identity.backendRef, `env:${env}:kubernetes`]
        const namespace = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : undefined

        const result = await store.listEvents({
          ...(namespace !== undefined ? { namespace } : {}),
          ...(args.fieldSelector !== undefined ? { fieldSelector: args.fieldSelector } : {}),
          limit: clampLimit(args.limit, 100),
          ...(args.continueToken !== undefined ? { continue: args.continueToken } : {}),
        })
        const rows = listRows(result)
        const warnings = rows.items.filter(item => isRow(item) && item['Type'] === 'Warning')
        const scope = namespace ?? '全部命名空间'
        let summary = `集群 ${identity.context} ${scope} 最近 ${rows.items.length} 条事件`
        if (warnings.length > 0) summary += `，其中 ${warnings.length} 条 Warning`
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: identity.backendRef,
            context: identity.context,
            namespace: namespace ?? null,
            mode: 'event_list' as const,
            item_count: rows.items.length,
            warning_count: warnings.length,
            items: rows.items,
            continue: rows.continueToken,
            remaining_item_count: rows.remainingItemCount,
          },
          summary,
          confidence: 0.95,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return eventListError(args, call, errorMessage(error))
      } finally {
        await call?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_query_k8s_resource',
    description:
      'Inspect any Kubernetes resource of the current session environment by apiVersion and kind — Deployment, '
      + 'StatefulSet, Service, Ingress, ConfigMap, Job, CronJob, PVC, Node… Default: object rows of that kind. '
      + 'With `name`: the full live object (spec, status, conditions). Read-only.',
    parameters: {
      apiVersion: { type: 'string', required: true, description: "Resource apiVersion, e.g. 'apps/v1', 'v1', 'networking.k8s.io/v1'." },
      kind: { type: 'string', required: true, description: "Resource kind, e.g. 'Deployment', 'Service', 'Pod', 'Ingress'." },
      name: { type: 'string', description: 'Resource name: fetches the full object. Omit to list rows.' },
      namespace: { type: 'string', description: 'Namespace for namespaced kinds; defaults to the environment business namespace.' },
      labelSelector: { type: 'string', description: 'Label selector for list mode.' },
      limit: { type: 'number', default: 50, description: 'Max rows in list mode (1-200).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let call: CallProvider | undefined
      try {
        call = await routeService(exec)
        const { env, store } = call
        const identity: KubernetesIdentity = { context: store.context, namespace: store.namespace, backendRef: store.backendRef }
        const refs = (): string[] => [identity.backendRef, `env:${env}:kubernetes`]
        const apiVersion = args.apiVersion as string
        const kind = args.kind as string
        const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined
        const namespace = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : undefined

        if (name !== undefined) {
          const result = await store.getResource(apiVersion, kind, name, namespace)
          const object = result.structured ?? {}
          return buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: {
              env,
              backend_ref: identity.backendRef,
              context: identity.context,
              namespace: namespace ?? null,
              mode: 'resource_detail' as const,
              api_version: apiVersion,
              kind,
              name,
              object,
            },
            summary: `${kind} ${name}@${identity.context} 的完整对象`,
            confidence: 0.95,
            refs: refs(),
          }) as unknown as JsonValue
        }

        const result = await store.listResources(apiVersion, kind, {
          ...(namespace !== undefined ? { namespace } : {}),
          ...(args.labelSelector !== undefined ? { labelSelector: args.labelSelector } : {}),
          limit: clampLimit(args.limit, 50),
        })
        const rows = listRows(result)
        const scope = namespace ?? '全部命名空间'
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env,
            backend_ref: identity.backendRef,
            context: identity.context,
            namespace: namespace ?? null,
            mode: 'resource_list' as const,
            api_version: apiVersion,
            kind,
            item_count: rows.items.length,
            items: rows.items,
            continue: rows.continueToken,
            remaining_item_count: rows.remainingItemCount,
          },
          summary: `${kind} ${scope} 共 ${rows.items.length} 行`,
          confidence: 0.95,
          refs: refs(),
        }) as unknown as JsonValue
      } catch (error) {
        return resourceError(args, call, errorMessage(error))
      } finally {
        await call?.release()
      }
    },
  }))

  /** pods tool error branch — keeps the Provider identity when routing succeeded. */
  function podListError(
    args: { pod?: unknown; namespace?: unknown },
    call: CallProvider | undefined,
    message: string,
  ): JsonValue {
    const env = call?.env ?? 'unknown'
    const fallback: KubernetesIdentity = call === undefined
      ? { context: '', namespace: '', backendRef: 'kubernetes:unresolved' }
      : { context: call.store.context, namespace: call.store.namespace, backendRef: call.store.backendRef }
    const namespace = typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : fallback.namespace
    const pod = typeof args.pod === 'string' && args.pod.length > 0 ? args.pod : undefined
    return buildEvidence({
      source: SOURCE,
      type: TYPE,
      data: {
        env,
        backend_ref: fallback.backendRef,
        context: fallback.context,
        namespace,
        mode: pod !== undefined ? 'pod_detail' as const : 'pod_list' as const,
        pod: pod ?? null,
        item_count: 0,
        items: [],
        error: message,
      },
      summary: `Kubernetes Pod 查询失败: ${message}`,
      confidence: 0,
      refs: [fallback.backendRef, `env:${env}:kubernetes`],
    }) as unknown as JsonValue
  }

  /** events tool error branch. */
  function eventListError(
    args: { namespace?: unknown },
    call: CallProvider | undefined,
    message: string,
  ): JsonValue {
    const env = call?.env ?? 'unknown'
    const fallback: KubernetesIdentity = call === undefined
      ? { context: '', namespace: '', backendRef: 'kubernetes:unresolved' }
      : { context: call.store.context, namespace: call.store.namespace, backendRef: call.store.backendRef }
    return buildEvidence({
      source: SOURCE,
      type: TYPE,
      data: {
        env,
        backend_ref: fallback.backendRef,
        context: fallback.context,
        namespace: typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : null,
        mode: 'event_list' as const,
        item_count: 0,
        warning_count: 0,
        items: [],
        error: message,
      },
      summary: `Kubernetes 事件查询失败: ${message}`,
      confidence: 0,
      refs: [fallback.backendRef, `env:${env}:kubernetes`],
    }) as unknown as JsonValue
  }

  /** resource tool error branch. */
  function resourceError(
    args: { apiVersion?: unknown; kind?: unknown; name?: unknown; namespace?: unknown },
    call: CallProvider | undefined,
    message: string,
  ): JsonValue {
    const env = call?.env ?? 'unknown'
    const fallback: KubernetesIdentity = call === undefined
      ? { context: '', namespace: '', backendRef: 'kubernetes:unresolved' }
      : { context: call.store.context, namespace: call.store.namespace, backendRef: call.store.backendRef }
    return buildEvidence({
      source: SOURCE,
      type: TYPE,
      data: {
        env,
        backend_ref: fallback.backendRef,
        context: fallback.context,
        namespace: typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : null,
        mode: typeof args.name === 'string' && args.name.length > 0 ? 'resource_detail' as const : 'resource_list' as const,
        api_version: args.apiVersion ?? null,
        kind: args.kind ?? null,
        name: typeof args.name === 'string' ? args.name : null,
        item_count: 0,
        items: [],
        error: message,
      },
      summary: `Kubernetes 资源查询失败: ${message}`,
      confidence: 0,
      refs: [fallback.backendRef, `env:${env}:kubernetes`],
    }) as unknown as JsonValue
  }
}
