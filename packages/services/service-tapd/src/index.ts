/**
 * TAPD OpenAPI client as a Cordis service — the defect-ticket evidence leg.
 *
 * Transport: Bearer personal token against https://api.tapd.cn. The token's
 * permissions follow the owning account's project role: reading bugs
 * (list/get/status_map) requires the account to be a member of the workspace
 * with 缺陷查看 permission. Without it every call returns TAPD's 403 shape
 * (`status: 403`, `info: doesn't have permission ...`) — surfaced verbatim
 * as error evidence, never fabricated.
 *
 * Envelope: TAPD answers `{status, data, info, meta}` where `status: 1`
 * means success (and 401/403 keep their HTTP codes inside the JSON body).
 *
 * @module @dsh-sentry/service-tapd
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRefField, resolveCredential, timeoutMsField } from '@dsh-sentry/datasource'

export interface Config {
  /** OpenAPI base; default is the public cloud. */
  endpoint?: string
  /** TAPD workspace (project) id — the tickets this deployment can see. */
  workspaceId: string
  tokenRef?: string
  token?: string
  timeoutMs?: number
}

/** One TAPD bug record, restricted to the fields we request. */
export interface TapdBug {
  id: string
  title: string
  status: string
  severity: string
  priority: string
  current_owner: string
  reporter: string
  created: string
  modified: string
  /** Full detail fields — present only from fetchBug(). */
  description?: string
  resolution?: string
  fixer?: string
  te?: string
  deadline?: string
  custom_field?: Record<string, string>
}

const DEFAULT_ENDPOINT = 'https://api.tapd.cn'
const FIELDS_LIST = 'id,title,status,severity,priority,current_owner,reporter,created,modified'
const FIELDS_DETAIL = `${FIELDS_LIST},description,resolution,fixer,te,deadline`

export class TapdService extends Service {
  static Config = z.object({
    endpoint: z.string().description('TAPD OpenAPI 地址，默认公有云 https://api.tapd.cn'),
    workspaceId: z.string().required().description('TAPD 项目 workspace_id'),
    tokenRef: credentialRefField('个人令牌的凭据引用，如 TAPD_TOKEN'),
    token: z.string().role('secret').description('令牌明文（优先用 tokenRef 引用）'),
    timeoutMs: timeoutMsField(),
  })

  static inject = ['credentials']

  private readonly config: Config
  readonly endpoint: string
  private readonly timeoutMs: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'tapd')
    this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
    this.config = config
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  /** Resolve the bearer token: reference wins over the literal. */
  private async tokenValue(): Promise<string> {
    if (this.config.tokenRef !== undefined) {
      const token = await resolveCredential(this.ctx, this.config.tokenRef)
      if (token !== undefined && token.length > 0) return token
    }
    if (this.config.token !== undefined && this.config.token.length > 0) {
      return this.config.token
    }
    throw new Error('tapd 凭据缺失，需要 token 或 tokenRef 注入')
  }

  /** GET one OpenAPI path and enforce the TAPD envelope. */
  private async getJson<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) query.set(key, String(value))
    const token = await this.tokenValue()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    // MCP 通道标记（TAPD 为 MCP 流量开的专用权限路径）：`Via: mcp` 头 +
    // `s=mcp` 参数。经典 /bugs/list、/bugs/get 端点要求企业级 API 权限
    // （个人令牌 403）；/bugs 端点 + MCP 标记允许个人令牌读取缺陷。
    query.set('s', 'mcp')
    let resp: Response
    try {
      resp = await fetch(`${this.endpoint}${path}?${query.toString()}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          via: 'mcp',
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await resp.text()
    let payload: { status?: number; data?: unknown; info?: string } = {}
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      payload = { info: text.slice(0, 200) }
    }
    // TAPD signals failures in-body (HTTP may stay 200); 401/403 arrive as JSON too.
    if (payload.status !== 1) {
      throw new Error(`TAPD ${path} 失败: ${payload.info ?? `HTTP ${resp.status}`}`)
    }
    return payload.data as T
  }

  /** Page through bugs by filter. `order` defaults to modified desc. */
  async listBugs(options: {
    status?: string
    severity?: string
    owner?: string
    reporter?: string
    createdStart?: string
    createdEnd?: string
    modifiedStart?: string
    modifiedEnd?: string
    title?: string
    limit?: number
    page?: number
  } = {}): Promise<TapdBug[]> {
    const params: Record<string, string | number> = {
      workspace_id: this.config.workspaceId,
      fields: FIELDS_LIST,
      limit: Math.min(options.limit ?? 30, 200),
      page: options.page ?? 1,
      order: 'modified desc',
    }
    if (options.status !== undefined) params['status'] = options.status
    if (options.severity !== undefined) params['severity'] = options.severity
    if (options.owner !== undefined) params['current_owner'] = options.owner
    if (options.reporter !== undefined) params['reporter'] = options.reporter
    if (options.createdStart !== undefined) params['created'] = `${options.createdStart}..${options.createdEnd ?? options.createdStart}`
    if (options.modifiedEnd !== undefined && options.modifiedStart !== undefined) {
      params['modified'] = `${options.modifiedStart}..${options.modifiedEnd}`
    }
    if (options.title !== undefined) params['title'] = options.title
    // /bugs 端点返回 [{Bug: {...}}] 实体包裹结构（实测 2026-08，个人令牌走
    // MCP 通道标记；/bugs/list 虽为文档端点但仅对企业 API 账号开放）。
    const data = await this.getJson<Array<{ Bug?: TapdBug } | TapdBug>>('/bugs', params)
    return data.map((row) => (row as { Bug?: TapdBug }).Bug ?? (row as TapdBug))
  }

  /** Full detail for one bug id (short ids are padded to TAPD long ids). */
  async fetchBug(id: string): Promise<TapdBug> {
    const data = await this.getJson<Array<{ Bug?: TapdBug } | TapdBug>>('/bugs', {
      workspace_id: this.config.workspaceId,
      id: this.toLongId(id),
      fields: FIELDS_DETAIL,
      page: 1,
      limit: 1,
    })
    const row = data[0]
    const bug = row !== undefined ? ((row as { Bug?: TapdBug }).Bug ?? (row as TapdBug)) : undefined
    if (bug === undefined || bug.id === undefined) {
      throw new Error(`TAPD 缺陷 ${id} 不存在或无权查看`)
    }
    return bug
  }

  /** 短 id → 长 id（云端格式：`11` + workspace_id + 9 位补零序号）。 */
  private toLongId(id: string): string {
    const trimmed = id.trim()
    if (/^\d+$/.test(trimmed) && trimmed.length <= 9) {
      return `11${this.config.workspaceId}${trimmed.padStart(9, '0')}`
    }
    return trimmed
  }

  /** Total bug count for the workspace (cheapest liveness check). */
  async count(): Promise<number> {
    const data = await this.getJson<{ count: number }>('/bugs/count', {
      workspace_id: this.config.workspaceId,
    })
    return data.count
  }
}

export default TapdService

declare module '@deepseek-ai/cordis' {
  interface Context {
    tapd: TapdService
  }
}
