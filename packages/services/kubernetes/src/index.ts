/**
 * KubernetesStore Provider: Kubernetes read-only view bridged over the
 * platform `kubernetes-mcp-server` gateway (streamable HTTP MCP).
 *
 * The deployed gateway (kubernetes-mcp-server, read_only toolset, Secret
 * denied server-side) fronts every cluster through Rancher-managed
 * kubeconfig contexts — the expensive problems of a native leg (kubeconfig
 * distribution per user, token custody, read-only enforcement, discovery)
 * stay solved once on the server. This Provider is the session-env-bound
 * half of the bridge: it owns one MCP session to the gateway and injects
 * the environment row's `context` into every tool call, so callers
 * physically cannot land on the gateway's default context
 * (`tst-platform-hosted-1`) by forgetting a parameter.
 *
 * The seam (`@dsh-sentry/kubernetes-store`, slot `kubernetesStore`) speaks
 * Kubernetes vocabulary only; everything below it is Provider internal:
 * - `initialize` returns the session id in the `mcp-session-id` response
 *   header, then `notifications/initialized` completes the handshake;
 * - every response may be `text/event-stream` (`event: message` + one
 *   `data:` JSON line) or plain JSON — both parsed;
 * - tool results carry `structuredContent` (machine rows / the raw object)
 *   or fall back to the first `content[].text` (pod logs are text-only);
 *   `isError: true` results are tool-level failures and throw here;
 * - an HTTP 404 means the session expired (gateway restart): the client
 *   re-initializes once and retries the call.
 *
 * The optional `tokenRef` is forward wiring for gateway authentication
 * (Bearer); today's gateway is unauthenticated and the ref stays unset.
 *
 * @module @dsh-sentry/service-kubernetes
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  credentialRefField,
  endpointField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'
import {
  KubernetesStore,
  type KubernetesListQuery,
  type KubernetesListResult,
  type KubernetesLogQuery,
  type KubernetesObject,
} from '@dsh-sentry/kubernetes-store'

export type {
  KubernetesListQuery,
  KubernetesListResult,
  KubernetesLogQuery,
  KubernetesObject,
} from '@dsh-sentry/kubernetes-store'

/** MCP protocol version this client speaks (matches the deployed gateway). */
const MCP_PROTOCOL_VERSION = '2025-06-18'

const CLIENT_INFO = { name: 'dsh-sentry-service-kubernetes', version: '0.1.0' }

/**
 * One gateway tool result — Provider-internal transport envelope. Machine
 * rows/object when the tool emits `structuredContent`, plus the first text
 * block; never crosses the seam in this shape.
 */
export interface McpToolResult {
  /** `structuredContent` of the tool result — table rows (`items`) or the raw object, tool-dependent. */
  structured: Record<string, unknown> | undefined
  /** First `content[].text` block — the human-readable table, or the log body for `pods_log`. */
  text: string
}

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Gateway base URL, e.g. `http://192.168.5.126:19080/mcp`. */
  endpoint: string
  /** Kubeconfig context this environment binds to (the env row's cluster). */
  context: string
  /** Business namespace used when a caller omits one. */
  namespace?: string
  /** Credential reference for the gateway Bearer token, e.g. `KUBERNETES_MCP_TOKEN`. */
  tokenRef?: string
  /** Literal token fallback when no reference is configured. Discouraged in composition files. */
  token?: string
  /** Per-request timeout in milliseconds. Defaults to 30000 (pod logs can be slow). */
  timeoutMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Map one gateway list envelope to the seam's row-page shape. */
function toListResult(result: McpToolResult): KubernetesListResult {
  const structured = result.structured ?? {}
  const items = Array.isArray(structured['items'])
    ? structured['items'].filter(isRecord)
    : []
  const continueToken = typeof structured['continue'] === 'string' ? structured['continue'] : null
  const remaining = structured['remainingItemCount']
  return {
    items,
    continue: continueToken,
    remainingItemCount: typeof remaining === 'number' ? remaining : null,
    text: result.text,
  }
}

/** Map one gateway get envelope to the seam's object shape. */
function toObject(result: McpToolResult): KubernetesObject {
  return { object: result.structured ?? {}, text: result.text }
}

/**
 * Parse one JSON-RPC response body: plain JSON or a `text/event-stream`
 * frame whose `data:` lines carry the payload.
 */
export function parseRpcBody(body: string): Record<string, unknown> {
  const trimmed = body.trim()
  if (trimmed.length === 0) throw new Error('响应体为空')
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Record<string, unknown>
  const dataLines = trimmed.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
  const joined = dataLines.join('\n').trim()
  const parsed = JSON.parse(joined) as Record<string, unknown>
  if (isRecord(parsed)) return parsed
  throw new Error('响应不是 JSON-RPC 对象')
}

export class KubernetesService extends KubernetesStore {
  static Config: z<Config> = z.object({
    endpoint: endpointField('kubernetes-mcp-server 网关地址，如 http://192.168.5.126:19080/mcp'),
    context: z.string().required().description('本环境绑定的 kubeconfig context（Rancher 集群名，随环境行配置）'),
    namespace: z.string().default('novo-one').description('工具缺省的业务命名空间'),
    tokenRef: credentialRefField('网关 Bearer token 的凭据引用（网关启用鉴权后配置）'),
    token: secretField('内联 token（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
  })

  /** Gateway URL verbatim from config, for evidence metadata. */
  readonly endpoint: string
  private readonly config: Config
  private readonly timeoutMs: number
  /** MCP session id from the `mcp-session-id` initialize response header. */
  private sessionId: string | undefined
  /** Single-flight initialize so concurrent first calls share one handshake. */
  private ready: Promise<void> | undefined

  constructor(ctx: Context, config: Config = { endpoint: '', context: '' }) {
    super(ctx)
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.config = config
  }

  /** Configuration suffices when endpoint and bound context are present. */
  override get configured(): boolean {
    return this.endpoint.length > 0 && this.config.context.length > 0
  }

  /** Kubeconfig context every call is pinned to. */
  override get context(): string {
    return this.config.context
  }

  /** Business namespace used when a tool call omits one. */
  override get namespace(): string {
    return this.config.namespace ?? 'novo-one'
  }

  /**
   * Stable, non-secret backend identity used in evidence refs and
   * `backend_ref` — context included, because one gateway serves every
   * environment and the context is what this Provider actually selects.
   */
  override get backendRef(): string {
    return `kubernetes:${this.config.context}@${this.endpoint}`
  }

  /** Gateway contexts the server's kubeconfig offers (probe/calibration helper; not part of the seam). */
  async listContexts(): Promise<string> {
    const result = await this.callTool('configuration_contexts_list', {})
    return result.text
  }

  /** `pods_list_in_namespace`: pod rows of one namespace (default: the configured one). */
  override async listPods(query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    const result = await this.callTool('pods_list_in_namespace', {
      namespace: query.namespace ?? this.namespace,
      ...(query.labelSelector !== undefined ? { labelSelector: query.labelSelector } : {}),
      ...(query.fieldSelector !== undefined ? { fieldSelector: query.fieldSelector } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.continue !== undefined ? { continue: query.continue } : {}),
    })
    return toListResult(result)
  }

  /** `pods_get`: one full Pod object (container statuses, restarts, node placement). */
  override async getPod(name: string, namespace?: string): Promise<KubernetesObject> {
    const result = await this.callTool('pods_get', {
      name,
      namespace: namespace ?? this.namespace,
    })
    return toObject(result)
  }

  /** `pods_log`: log text of one pod container (raw text, no structuredContent). */
  override async getPodLogs(name: string, query: KubernetesLogQuery = {}): Promise<string> {
    const result = await this.callTool('pods_log', {
      name,
      namespace: query.namespace ?? this.namespace,
      ...(query.container !== undefined ? { container: query.container } : {}),
      ...(query.tail !== undefined ? { tail: query.tail } : {}),
      ...(query.previous === true ? { previous: true } : {}),
    })
    return result.text
  }

  /** `events_list`: warning/error/state-change events; omitting namespace scans the whole cluster. */
  override async listEvents(query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    const result = await this.callTool('events_list', {
      ...(query.namespace !== undefined ? { namespace: query.namespace } : {}),
      ...(query.fieldSelector !== undefined ? { fieldSelector: query.fieldSelector } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.continue !== undefined ? { continue: query.continue } : {}),
    })
    return toListResult(result)
  }

  /** `resources_get`: one full object by apiVersion/kind/name (e.g. Deployment, Ingress, PVC). */
  override async getResource(
    apiVersion: string,
    kind: string,
    name: string,
    namespace?: string,
  ): Promise<KubernetesObject> {
    const result = await this.callTool('resources_get', {
      apiVersion,
      kind,
      name,
      ...(namespace !== undefined ? { namespace } : {}),
    })
    return toObject(result)
  }

  /** `resources_list`: object rows by apiVersion/kind, optionally namespace- and label-scoped. */
  override async listResources(apiVersion: string, kind: string, query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    const result = await this.callTool('resources_list', {
      apiVersion,
      kind,
      ...(query.namespace !== undefined ? { namespace: query.namespace } : {}),
      ...(query.labelSelector !== undefined ? { labelSelector: query.labelSelector } : {}),
      ...(query.fieldSelector !== undefined ? { fieldSelector: query.fieldSelector } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.continue !== undefined ? { continue: query.continue } : {}),
    })
    return toListResult(result)
  }

  /**
   * Call one gateway tool with this Provider's context pinned in — transport
   * helper kept public for Provider tests and probes, never part of the
   * seam. The context override is unconditional: even a caller-supplied
   * `context` argument must not cross the Session environment boundary.
   */
  async callTool(tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.rpc('tools/call', {
      name: tool,
      arguments: { ...args, context: this.config.context },
    })
    const payload = result['result']
    if (!isRecord(payload)) {
      throw new Error(`Kubernetes MCP 工具 ${tool} 返回的结果无法解析，原始响应：${JSON.stringify(result).slice(0, 500)}`)
    }
    const content = Array.isArray(payload['content']) ? payload['content'] : []
    const firstText = content.find(isRecord)?.['text']
    const text = typeof firstText === 'string' ? firstText : ''
    if (payload['isError'] === true) {
      throw new Error(`Kubernetes MCP 工具 ${tool} 返回错误: ${text || JSON.stringify(payload).slice(0, 500)}`)
    }
    const structured = isRecord(payload['structuredContent']) ? payload['structuredContent'] : undefined
    if (structured === undefined && text.length === 0) {
      throw new Error(`Kubernetes MCP 工具 ${tool} 返回了空结果`)
    }
    return { structured, text }
  }

  /** One JSON-RPC request; a 404 session expiry re-initializes once and retries. */
  private async rpc(method: string, params?: Record<string, unknown>, retried = false): Promise<Record<string, unknown>> {
    await this.ensureSession()
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(params !== undefined ? { id: nextRequestId(), method, params } : { method }),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`请求 Kubernetes MCP 失败: ${errorMessage(cause)}`)
    }
    if (response.status === 404 && !retried && params !== undefined) {
      // Gateway restarted and dropped the session: handshake again, then retry the call.
      this.sessionId = undefined
      this.ready = undefined
      return this.rpc(method, params, true)
    }
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`请求 Kubernetes MCP 失败: HTTP ${response.status}: ${detail.slice(0, 300)}`)
    }
    let payload: Record<string, unknown>
    try {
      payload = parseRpcBody(await response.text())
    } catch (cause) {
      throw new Error(`请求 Kubernetes MCP 失败: ${errorMessage(cause)}`)
    }
    if (payload['error'] !== undefined) {
      const message = isRecord(payload['error']) ? String(payload['error']['message'] ?? '') : ''
      throw new Error(`请求 Kubernetes MCP 失败: ${message || JSON.stringify(payload['error']).slice(0, 300)}`)
    }
    return payload
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId !== undefined ? { 'mcp-session-id': this.sessionId } : {}),
    }
    if (this.tokenHeader !== undefined) headers['authorization'] = this.tokenHeader
    return headers
  }

  private tokenHeader: string | undefined

  /** Resolve the optional gateway token once per session handshake. */
  private async resolveTokenHeader(): Promise<void> {
    let token: string | undefined
    if (this.config.tokenRef !== undefined) {
      token = await resolveCredential(this.ctx, this.config.tokenRef)
    }
    token ??= this.config.token
    this.tokenHeader = token !== undefined && token.length > 0 ? `Bearer ${token}` : undefined
  }

  /** Lazy single-flight MCP handshake: initialize → capture session id → initialized notification. */
  private async ensureSession(): Promise<void> {
    if (this.sessionId !== undefined) return
    this.ready ??= (async () => {
      await this.resolveTokenHeader()
      let response: Response
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: nextRequestId(),
            method: 'initialize',
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: CLIENT_INFO,
            },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (cause) {
        this.ready = undefined
        throw new Error(`请求 Kubernetes MCP 失败: ${errorMessage(cause)}`)
      }
      if (!response.ok) {
        this.ready = undefined
        const detail = await response.text()
        throw new Error(`请求 Kubernetes MCP 失败: HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
      const sessionId = response.headers.get('mcp-session-id')
      if (sessionId === null || sessionId.length === 0) {
        this.ready = undefined
        throw new Error('请求 Kubernetes MCP 失败: initialize 响应缺少 mcp-session-id 头')
      }
      this.sessionId = sessionId
      // Drain the initialize body (SSE or JSON — the session header is what matters).
      await response.text()
      // initialized notification: the gateway tolerates an empty 202 body; failures here
      // fail the handshake so the next call starts clean.
      try {
        const notify = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!notify.ok && notify.status !== 202) {
          throw new Error(`HTTP ${notify.status}`)
        }
      } catch (cause) {
        this.sessionId = undefined
        this.ready = undefined
        throw new Error(`请求 Kubernetes MCP 失败: initialized 通知失败: ${errorMessage(cause)}`)
      }
    })()
    try {
      await this.ready
    } catch (cause) {
      this.ready = undefined
      throw cause
    }
  }
}

/** Monotonic JSON-RPC request ids (per process; the gateway only needs uniqueness per session). */
let requestId = 0
function nextRequestId(): number {
  requestId += 1
  return requestId
}

export default KubernetesService
