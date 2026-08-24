import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ZadigService, {
  buildWebUiUrl,
  formatTs,
  parseImageTag,
} from '../src/index.ts'

/**
 * Golden tests pinned to `skills/zadig-inspector/scripts/inspect.py`: image
 * tag parsing (the docstring example), web-UI URL building, request headers
 * (browser accepts + referer + Bearer), workloads query params, and the
 * services/scales response walkers.
 */

const ENDPOINT = 'https://zadig.example.com'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function lastCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mock.mock.calls.at(-1)
  if (call === undefined) throw new Error('expected at least one fetch call')
  return call as [string, RequestInit]
}

function makeService(ctx: Context, extra: Record<string, unknown> = {}): ZadigService {
  return new ZadigService(ctx, {
    endpoint: ENDPOINT,
    project: 'novo-one',
    envName: 'dev-env',
    ...extra,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('parseImageTag — port of _parse_image', () => {
  it('parses the docstring example tag fully', () => {
    const parsed = parseImageTag(
      'hub.yeastardigital.com/novo-one/commctl-config:20260727155647-3325-263.0.2.1-dev',
    )
    expect(parsed.service).toBe('commctl-config')
    expect(parsed.build_time_raw).toBe('20260727155647')
    expect(parsed.build_time).toBe('2026-07-27T15:56:47Z')
    expect(parsed.build_id).toBe('3325')
    expect(parsed.version).toBe('263.0.2.1')
    expect(parsed.branch).toBe('dev')
  })

  it('treats a multi-dash branch as one string', () => {
    const parsed = parseImageTag(
      'hub.example.com/team/payment-service:20260727144023-3321-263.0.3.2-feat-scrum-2',
    )
    expect(parsed.service).toBe('payment-service')
    expect(parsed.build_id).toBe('3321')
    expect(parsed.version).toBe('263.0.3.2')
    expect(parsed.branch).toBe('feat-scrum-2')
  })

  it('falls back to branch-only for short tags and returns nulls without a colon', () => {
    expect(parseImageTag('hub.example.com/team/svc:main').branch).toBe('main')
    const bare = parseImageTag('hub.example.com/team/svc')
    expect(bare.service).toBeNull()
    expect(bare.branch).toBeNull()
  })

  it('keeps a non-timestamp head uninterpreted', () => {
    const parsed = parseImageTag('hub.example.com/team/svc:latest-3325-263.0.2.1-dev')
    expect(parsed.build_time_raw).toBeNull()
    expect(parsed.build_time).toBeNull()
    expect(parsed.build_id).toBe('3325')
  })
})

describe('formatTs — port of _format_ts', () => {
  it('converts Unix seconds to ISO8601 Z', () => {
    // 1785139207 is genuinely 2026-07-27T08:00:07Z; the Python demo fixture
    // showed it as 15:40:07Z, which was fabricated example data (recorded
    // drift, kept verbatim in the tool's demo payload).
    expect(formatTs(1785139207)).toBe('2026-07-27T08:00:07Z')
  })

  it('returns null for falsy or non-numeric input', () => {
    expect(formatTs(null)).toBeNull()
    expect(formatTs(0)).toBeNull()
    expect(formatTs(undefined)).toBeNull()
  })
})

describe('buildWebUiUrl — port of _web_ui_url', () => {
  it('builds the env-list route', () => {
    expect(buildWebUiUrl(ENDPOINT, 'novo-one', 'dev-env'))
      .toBe(`${ENDPOINT}/v1/projects/detail/novo-one/envs/detail?envName=dev-env&projectName=novo-one`)
  })

  it('builds the service route with workLoadType', () => {
    expect(buildWebUiUrl(ENDPOINT, 'novo-one', 'dev-env', 'order-service'))
      .toBe(`${ENDPOINT}/v1/projects/detail/novo-one/envs/detail/order-service?envName=dev-env&projectName=novo-one&workLoadType=Deployment`)
  })
})

describe('ZadigService.fetchServices — golden request + parsing', () => {
  it('GETs workloads with referer, browser accepts, and the script-era params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      services: [
        {
          service_name: 'commctl-config',
          status: 'Running',
          ready: 'ready',
          error: '',
          images: ['hub.example.com/novo-one/commctl-config:20260727155647-3325-263.0.2.1-dev'],
        },
        { service_name: 'commctl-call-control', status: 'Updating', ready: 'not ready' },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const rows = await service.fetchServices()

    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(
      `${ENDPOINT}/api/aslan/environment/environments/dev-env/workloads`
      + '?projectName=novo-one&filter=releaseName%3D*%2Cname%3D&perPage=999&page=1',
    )
    const headers = init.headers as Record<string, string>
    expect(headers['accept']).toBe('application/json, text/plain, */*')
    expect(headers['user-agent']).toBe('endurance-sentry-zadig-inspector/0.1.0')
    expect(headers['referer']).toBe(`${ENDPOINT}/v1/projects/detail/novo-one/envs/detail?envName=dev-env&projectName=novo-one`)
    expect(headers['authorization']).toBeUndefined()

    // Sorted by name; image parsed and flattened next to the raw one.
    expect(rows.map(row => row.name)).toEqual(['commctl-call-control', 'commctl-config'])
    const config = rows.find(row => row.name === 'commctl-config')
    if (config === undefined) throw new Error('commctl-config row missing')
    expect(config.image).toBe('hub.example.com/novo-one/commctl-config:20260727155647-3325-263.0.2.1-dev')
    // Python `**parsed`: the tag fields are flattened into the row.
    expect(config.version).toBe('263.0.2.1')
    expect(config.branch).toBe('dev')
    expect(config.build_time).toBe('2026-07-27T15:56:47Z')
    expect(config.workLoadType).toBe('Deployment')
  })

  it('sends the Bearer token when a ref resolves', async () => {
    vi.stubEnv('ZADIG_API_TOKEN', 'tok-1')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ services: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context(), { tokenRef: 'ZADIG_API_TOKEN' })
    await service.fetchServices()

    const headers = lastCall(fetchMock)[1].headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer tok-1')
  })

  it('rejects malformed workloads payloads with the original wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })))
    const service = makeService(new Context())
    await expect(service.fetchServices()).rejects.toThrow('Zadig workloads 返回的数据格式无法解析')
  })

  it('wraps HTTP failures with 请求 Zadig API 失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    const service = makeService(new Context())
    await expect(service.fetchServices()).rejects.toThrow('请求 Zadig API 失败')
  })
})

describe('ZadigService.fetchServiceDetail — golden request + parsing', () => {
  it('GETs the service detail and flattens scales[0] into the deployment shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      service_name: 'commctl-config',
      namespace: 'novo-one',
      env_name: 'dev-env',
      product_name: 'novo-one',
      scales: [
        {
          status: 'Running',
          ready: 'ready',
          replicas: 2,
          images: [{ image: 'hub.example.com/novo-one/commctl-config:20260727155647-3325-263.0.2.1-dev' }],
          pods: [
            {
              name: 'commctl-config-6c7679b978-ghj6s',
              status: 'Running',
              age: '4h',
              ip: '10.0.0.30',
              node_name: 'vm-5-5-ubuntu',
              started_at: 1785139207,
              containers: [{ name: 'commctl-config', image: 'x:y', restart_count: 0, status: 'running', ready: true }],
            },
            {
              name: 'commctl-config-6c7679b978-abcde',
              status: 'Running',
              started_at: 1785138900,
              containers: [],
            },
          ],
        },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const detail = await service.fetchServiceDetail('commctl-config')

    const [url] = lastCall(fetchMock)
    expect(url).toBe(
      `${ENDPOINT}/api/aslan/environment/environments/dev-env/services/commctl-config`
      + '?projectName=novo-one&envType=&workLoadType=Deployment',
    )

    expect(detail['service_name']).toBe('commctl-config')
    expect(detail['replicas']).toBe(2)
    expect(detail['version']).toBe('263.0.2.1')
    const pods = detail['pods'] as { started_at_iso: string | null }[]
    expect(pods[0]?.started_at_iso).toBe('2026-07-27T08:00:07Z')
    // latest_started_at = max over pods with a timestamp
    expect(detail['latest_started_at']).toBe(1785139207)
    expect(detail['latest_started_at_iso']).toBe('2026-07-27T08:00:07Z')
  })

  it('throws the original wording when scales is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ scales: [] })))
    const service = makeService(new Context())
    await expect(service.fetchServiceDetail('svc-x')).rejects.toThrow('Zadig 返回的服务 svc-x 详情中无 scales 数据')
  })
})
