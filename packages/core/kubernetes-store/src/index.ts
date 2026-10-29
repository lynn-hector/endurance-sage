/**
 * Backend-neutral Kubernetes read-only view Service Definition.
 *
 * A Provider implements this seam and owns the transport, endpoint,
 * credentials and kubeconfig-context routing — today the platform
 * `kubernetes-mcp-server` gateway (JSON-RPC over streamable HTTP), tomorrow
 * any other reader. Consumers depend only on `ctx.kubernetesStore` and
 * speak Kubernetes vocabulary: pods, container logs, events and objects by
 * apiVersion/kind. Gateway tool names, JSON-RPC frames, SSE bodies, session
 * ids and response envelopes never cross this seam; row pages keep the
 * backend's raw rows plus its human-readable table so evidence stays
 * verbatim, and `continue` is the Kubernetes list-protocol continuation
 * token, not a gateway detail.
 *
 * @module @dsh-sentry/kubernetes-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** Row-list intent shared by pods, events and generic resources. */
export interface KubernetesListQuery {
  /** Namespace to scope; omitted means the Provider's default. */
  namespace?: string
  /** Label selector, e.g. 'app.kubernetes.io/name=commctl-config'. */
  labelSelector?: string
  /** Field selector, e.g. 'status.phase=Failed'. */
  fieldSelector?: string
  /** Server page-size cap; omitting it lets large clusters fail the call. */
  limit?: number
  /** Opaque continuation token from a previous page's result. */
  continue?: string
}

/** Container-log intent for one pod. */
export interface KubernetesLogQuery {
  /** Namespace of the pod; defaults to the Provider's business namespace. */
  namespace?: string
  /** Container name; the pod's default container when omitted. */
  container?: string
  /** Tail lines (Provider default 100). */
  tail?: number
  /** Previous terminated container instance — post-crash log retrieval. */
  previous?: boolean
}

/** One page of object rows. */
export interface KubernetesListResult {
  /** This page's rows, raw as the backend shaped them, for the evidence layer. */
  items: Record<string, unknown>[]
  /** Continuation token for the next page; null when the list ended. */
  continue: string | null
  /** Remaining-item estimate when the backend reports one; null otherwise. */
  remainingItemCount: number | null
  /** Human-readable backend rendering (the model-readable table). */
  text: string
}

/** One full live object (metadata/spec/status). */
export interface KubernetesObject {
  /** The object itself, raw. */
  object: Record<string, unknown>
  /** Human-readable backend rendering. */
  text: string
}

/**
 * Exactly one Provider occupies this slot per environment Context.
 * Read-only by contract: no method mutates cluster state.
 */
export abstract class KubernetesStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'kubernetesStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /** True when this Provider's configuration suffices to serve queries. */
  abstract get configured(): boolean

  /** Cluster (kubeconfig context) this Provider is pinned to. */
  abstract get context(): string

  /** Business namespace used when a query omits one. */
  abstract get namespace(): string

  /** Pod rows of one namespace (the Provider's default when omitted). */
  abstract listPods(query?: KubernetesListQuery): Promise<KubernetesListResult>

  /** One full Pod object (container statuses, images, node placement). */
  abstract getPod(name: string, namespace?: string): Promise<KubernetesObject>

  /** Log text of one pod container; empty only when the backend returns none. */
  abstract getPodLogs(name: string, query?: KubernetesLogQuery): Promise<string>

  /** Event rows (warnings, errors, state changes); omitting the namespace scans the whole cluster. */
  abstract listEvents(query?: KubernetesListQuery): Promise<KubernetesListResult>

  /** One full object by apiVersion/kind/name (Deployment, Ingress, PVC…). */
  abstract getResource(apiVersion: string, kind: string, name: string, namespace?: string): Promise<KubernetesObject>

  /** Object rows of one kind, optionally namespace- and label-scoped. */
  abstract listResources(apiVersion: string, kind: string, query?: KubernetesListQuery): Promise<KubernetesListResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kubernetesStore: KubernetesStore
  }
}

export default KubernetesStore
