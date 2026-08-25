/**
 * Zadig OpenAPI client (environment workloads + service detail) as a Cordis
 * service.
 *
 * Port of the transport + parsing half of the original
 * `skills/zadig-inspector/scripts/inspect.py`: GET
 * `/api/aslan/environment/environments/{env_name}/workloads` and
 * `/api/aslan/environment/environments/{env_name}/services/{service_name}`
 * with browser-ish headers, a forced `referer` pointing at the Zadig web UI
 * route, and an optional Bearer token; image tags are parsed into
 * build-time/build-id/version/branch (`_parse_image`), pods into the
 * flattened shape with ISO started-at timestamps.
 *
 * Deliberate deviations from the script era:
 * - `requests` is replaced by `fetch`; `raise_for_status` HTTP errors and
 *   other network failures are uniformly wrapped as
 *   `请求 Zadig API 失败: ...` (the original's except-branch wording for
 *   both `requests.RequestException` subtypes);
 * - the demo/dry-run "degraded config" fallback (example.com defaults when
 *   `config/{env}.yml` was incomplete) is gone — the plugin Config is
 *   validated by the schema, so there is nothing to degrade from;
 * - `project` / `env_name` / `workLoadType` are plugin config instead of
 *   per-call CLI context.
 *
 * @module @dsh-sentry/service-zadig
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  credentialRefField,
  endpointField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

const WORKLOADS_PATH = '/api/aslan/environment/environments/{env_name}/workloads'
const SERVICE_DETAIL_PATH = '/api/aslan/environment/environments/{env_name}/services/{service_name}'
const IMAGE_TAG_RE = /^\d{14}$/

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Zadig base URL. */
  endpoint: string
  /** Zadig project name (the original `zadig.project`). */
  project: string
  /** Zadig environment name (the original `zadig.env_name`). */
  envName: string
  /** Workload type filter, default `Deployment` (the original `zadig.workLoadType`). */
  workLoadType?: string
  /** Credential reference for the Zadig API token, e.g. `ZADIG_API_TOKEN`. */
  tokenRef?: string
  /** Literal token fallback when no reference is configured. Discouraged in composition files. */
  token?: string
  /** Per-request timeout in milliseconds. Defaults to 30000 (the script's requests timeout). */
  timeoutMs?: number
}

/** Parsed image-tag fields, the original `_parse_image` result. */
export interface ParsedImage {
  image: string
  service: string | null
  build_time_raw: string | null
  build_time: string | null
  build_id: string | null
  version: string | null
  branch: string | null
}

/** One workload row from {@link ZadigService.fetchServices}; the parsed image-tag fields are flattened in, Python `**parsed` style. */
export interface ZadigServiceRow {
  name: string
  status: unknown
  ready: unknown
  error: unknown
  workLoadType: string
  image: string | null
  pipeline_url: string
  service?: string | null
  build_time_raw?: string | null
  build_time?: string | null
  build_id?: string | null
  version?: string | null
  branch?: string | null
  [key: string]: unknown
}

/** One pod of a service detail, the original `_fetch_service_detail` shape. */
export interface ZadigPod {
  name: unknown
  status: unknown
  age: unknown
  ip: unknown
  node_name: unknown
  started_at: unknown
  started_at_iso: string | null
  pod_ready: unknown
  containers_ready: unknown
  containers: Record<string, unknown>[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize an optional passthrough field to `null` when the Zadig response
 * omits it. Raw `undefined` embedded in a tool output fails the harness's
 * lossless-JSON snapshot (`value is not lossless JSON`), and
 * `JSON.stringify` silently drops such keys — so this bug class is invisible
 * to the original Python script era and only surfaces under the strict JSON
 * boundary.
 */
function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

/**
 * Port of `_parse_image`: split `{repo}:{tag}` and decode the tag as
 * `{timestamp}-{build_id}-{version?}-{branch}`.
 */
export function parseImageTag(image: string): ParsedImage {
  const result: ParsedImage = {
    image,
    service: null,
    build_time_raw: null,
    build_time: null,
    build_id: null,
    version: null,
    branch: null,
  }
  if (!image.includes(':')) return result

  const lastColon = image.lastIndexOf(':')
  const repo = image.slice(0, lastColon)
  const tag = image.slice(lastColon + 1)
  result.service = repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : repo

  const parts = tag.split('-')
  if (parts.length < 2) {
    result.branch = tag
    return result
  }

  const buildTimeRaw = parts[0] as string
  if (IMAGE_TAG_RE.test(buildTimeRaw)) {
    result.build_time_raw = buildTimeRaw
    const dt = new Date(Date.UTC(
      Number(buildTimeRaw.slice(0, 4)),
      Number(buildTimeRaw.slice(4, 6)) - 1,
      Number(buildTimeRaw.slice(6, 8)),
      Number(buildTimeRaw.slice(8, 10)),
      Number(buildTimeRaw.slice(10, 12)),
      Number(buildTimeRaw.slice(12, 14)),
    ))
    if (!Number.isNaN(dt.getTime())) {
      result.build_time = `${dt.toISOString().slice(0, 19)}Z`
    }
  }

  result.build_id = parts[1] ?? null
  const rest = parts.slice(2)
  if (rest.length === 0) return result

  // If the first remaining segment looks like a semver, it is the version
  // and the rest is the branch.
  if (/^\d+(\.\d+)*/.test(rest[0] as string)) {
    result.version = rest[0] as string
    result.branch = rest.length > 1 ? rest.slice(1).join('-') : null
  } else {
    result.branch = rest.join('-')
  }
  return result
}

/** Port of `_format_ts`: Unix seconds to ISO8601 Z, null on falsy/bad input. */
export function formatTs(value: unknown): string | null {
  if (value === null || value === undefined || value === 0 || value === '' || value === false) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return null
  const dt = new Date(seconds * 1000)
  if (Number.isNaN(dt.getTime())) return null
  return `${dt.toISOString().slice(0, 19)}Z`
}

/** Port of `_web_ui_url`: link to the Zadig web UI route for evidence consumers. */
export function buildWebUiUrl(
  endpoint: string,
  project: string,
  envName: string,
  service?: string,
): string {
  const base = `${endpoint.replace(/\/+$/, '')}/v1/projects/detail/${project}/envs/detail`
  if (service) {
    return `${base}/${service}?envName=${envName}&projectName=${project}&workLoadType=Deployment`
  }
  return `${base}?envName=${envName}&projectName=${project}`
}

/**
 * Zadig OpenAPI client. Token resolves per request through the credential
 * plane; there is no session to cache (stateless Bearer auth).
 */
export class ZadigService extends Service {
  static Config: z<Config> = z.object({
    endpoint: endpointField('Zadig 地址，如 https://zadig.cn-0.dev.novo-one.com'),
    project: z.string().required().description('Zadig 项目名（原 zadig.project）'),
    envName: z.string().required().description('Zadig 环境名（原 zadig.env_name）'),
    workLoadType: z.string().default('Deployment').description('工作负载类型（原 zadig.workLoadType，默认 Deployment）'),
    tokenRef: credentialRefField('Zadig API token 的凭据引用，如 ZADIG_API_TOKEN'),
    token: secretField('内联 token（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
  })

  /** Configured base URL with trailing slashes stripped, for evidence metadata. */
  readonly endpoint: string
  private readonly config: Config
  private readonly timeoutMs: number

  constructor(ctx: Context, config: Config = { endpoint: '', project: '', envName: '' }) {
    super(ctx, 'zadig')
    this.endpoint = (config.endpoint ?? '').replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.config = config
  }

  /** Configured project name. */
  get project(): string {
    return this.config.project
  }

  /** Configured environment name. */
  get envName(): string {
    return this.config.envName
  }

  /** `workLoadType` default `Deployment`, the original `_work_load_type`. */
  get workLoadType(): string {
    return this.config.workLoadType ?? 'Deployment'
  }

  /** Original `_request_headers`: browser-ish accepts + optional Bearer token. */
  private async requestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      priority: 'u=1, i',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'endurance-sentry-zadig-inspector/0.1.0',
    }
    let token: string | undefined
    if (this.config.tokenRef !== undefined) {
      token = await resolveCredential(this.ctx, this.config.tokenRef)
    }
    token ??= this.config.token
    if (token) headers['authorization'] = `Bearer ${token}`
    return headers
  }

  /** GET JSON with the original error wrapping (`请求 Zadig API 失败: ...`). */
  private async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new Error(`请求 Zadig API 失败: ${errorMessage(cause)}`)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`请求 Zadig API 失败: Zadig HTTP ${resp.status}: ${detail}`)
    }
    try {
      return await resp.json()
    } catch (cause) {
      throw new Error(`请求 Zadig API 失败: ${errorMessage(cause)}`)
    }
  }

  /** Constructed workloads request, for dry-run evidence. */
  buildWorkloadsRequest(): { url: string; params: Record<string, string> } {
    return {
      url: `${this.endpoint}${WORKLOADS_PATH.replace('{env_name}', encodeURIComponent(this.envName))}`,
      params: {
        projectName: this.config.project,
        filter: 'releaseName=*,name=',
        perPage: '999',
        page: '1',
      },
    }
  }

  /** Constructed service-detail request, for dry-run evidence. */
  buildServiceDetailRequest(service: string): { url: string; params: Record<string, string> } {
    return {
      url: `${this.endpoint}${SERVICE_DETAIL_PATH
        .replace('{env_name}', encodeURIComponent(this.envName))
        .replace('{service_name}', encodeURIComponent(service))}`,
      params: {
        projectName: this.config.project,
        envType: '',
        workLoadType: this.workLoadType,
      },
    }
  }

  /**
   * Port of `_fetch_services`: list every workload of the environment, each
   * row carrying the parsed image tag and a pipeline URL; sorted by name.
   */
  async fetchServices(): Promise<ZadigServiceRow[]> {
    const { url, params } = this.buildWorkloadsRequest()
    const headers = await this.requestHeaders()
    headers['referer'] = buildWebUiUrl(this.endpoint, this.config.project, this.envName)
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

    const payload = await this.getJson(`${url}?${query}`, headers)
    const services = isRecord(payload) ? payload['services'] : undefined
    if (!Array.isArray(services)) {
      throw new Error(
        `Zadig workloads 返回的数据格式无法解析，原始响应：${JSON.stringify(payload).slice(0, 500)}`,
      )
    }

    const result: ZadigServiceRow[] = []
    for (const svc of services) {
      if (!isRecord(svc)) continue
      const name = svc['service_name']
      if (typeof name !== 'string' || name.length === 0) continue
      const images = Array.isArray(svc['images']) ? svc['images'] : []
      const image = images.length > 0 && typeof images[0] === 'string' ? images[0] : null
      result.push({
        name,
        status: orNull(svc['status']),
        ready: orNull(svc['ready']),
        error: orNull(svc['error']),
        workLoadType: typeof svc['workLoadType'] === 'string' ? svc['workLoadType'] : this.workLoadType,
        image,
        ...(image !== null ? parseImageTag(image) : {}),
        pipeline_url: buildWebUiUrl(this.endpoint, this.config.project, this.envName, name),
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Port of `_fetch_service_detail`: the latest deployment of one service —
   * `scales[0]` images, flattened pods with ISO started-at, and the newest
   * pod start across the list.
   */
  async fetchServiceDetail(service: string): Promise<Record<string, unknown>> {
    const { url, params } = this.buildServiceDetailRequest(service)
    const headers = await this.requestHeaders()
    headers['referer'] = buildWebUiUrl(this.endpoint, this.config.project, this.envName, service)
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

    const payload = await this.getJson(`${url}?${query}`, headers)
    if (!isRecord(payload)) {
      throw new Error(
        `Zadig service detail 返回的数据格式无法解析，原始响应：${JSON.stringify(payload).slice(0, 500)}`,
      )
    }

    const scales = Array.isArray(payload['scales']) ? payload['scales'] : []
    if (scales.length === 0) {
      throw new Error(`Zadig 返回的服务 ${service} 详情中无 scales 数据`)
    }
    const scale = isRecord(scales[0]) ? scales[0] as Record<string, unknown> : {}

    const scaleImages = (Array.isArray(scale['images']) ? scale['images'] : [])
      .filter(isRecord)
      .map(img => img['image'])
      .filter((img): img is string => typeof img === 'string')
    const mainImage = scaleImages[0] ?? null

    const pods: ZadigPod[] = []
    for (const pod of Array.isArray(scale['pods']) ? scale['pods'] : []) {
      if (!isRecord(pod)) continue
      pods.push({
        name: orNull(pod['name']),
        status: orNull(pod['status']),
        age: orNull(pod['age']),
        ip: orNull(pod['ip']),
        node_name: orNull(pod['node_name']),
        started_at: orNull(pod['started_at']),
        started_at_iso: formatTs(pod['started_at']),
        pod_ready: orNull(pod['pod_ready']),
        containers_ready: orNull(pod['containers_ready']),
        containers: (Array.isArray(pod['containers']) ? pod['containers'] : [])
          .filter(isRecord)
          .map(c => ({
            name: orNull(c['name']),
            image: orNull(c['image']),
            restart_count: orNull(c['restart_count']),
            status: orNull(c['status']),
            ready: orNull(c['ready']),
          })),
      })
    }

    const startedValues = pods
      .map(p => p.started_at)
      .filter((v): v is number => typeof v === 'number')
    const latestStarted = startedValues.length > 0 ? Math.max(...startedValues) : null

    return {
      service_name: payload['service_name'] ?? service,
      namespace: orNull(payload['namespace']),
      env_name: payload['env_name'] ?? this.envName,
      product_name: payload['product_name'] ?? this.config.project,
      status: scale['status'] ?? orNull(payload['status']),
      ready: orNull(scale['ready']),
      replicas: orNull(scale['replicas']),
      image: mainImage,
      ...(mainImage !== null ? parseImageTag(mainImage) : {}),
      images: scaleImages,
      pods,
      latest_started_at: latestStarted,
      latest_started_at_iso: formatTs(latestStarted),
      pipeline_url: buildWebUiUrl(this.endpoint, this.config.project, this.envName, service),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    zadig: ZadigService
  }
}

export default ZadigService
