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

describe('ZadigService identity', () => {
  it('exposes a stable backendRef for Consumer evidence', () => {
    const service = makeService(new Context(), { endpoint: `${ENDPOINT}/` })
    expect(service.backendRef).toBe(`zadig:${ENDPOINT}`)
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

describe('ZadigService.fetchWorkflowTasks — golden request + compression', () => {
  it('GETs workflowtask with the browser-era params and pipelines referer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ workflow_list: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    await service.fetchWorkflowTasks({ workflowName: 'static-code-scanning-and-build-deploy' })

    const [url, init] = lastCall(fetchMock)
    expect(url).toBe(
      `${ENDPOINT}/api/aslan/workflow/v4/workflowtask`
      + '?workflow_name=static-code-scanning-and-build-deploy&page_num=1&page_size=20'
      + '&projectName=novo-one&queryType=&filters=&jobName=',
    )
    const headers = init.headers as Record<string, string>
    expect(headers['referer']).toBe(
      `${ENDPOINT}/v1/projects/detail/novo-one/pipelines/custom/static-code-scanning-and-build-deploy`,
    )
  })

  it('honors project override and page size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ workflow_list: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    await service.fetchWorkflowTasks({ workflowName: 'wf', project: 'other-project', pageNum: 2, pageSize: 50 })

    const [url] = lastCall(fetchMock)
    expect(url).toContain('projectName=other-project')
    expect(url).toContain('page_num=2')
    expect(url).toContain('page_size=50')
  })

  it('compresses stages/jobs, dedupes code_info across service modules, ISO-ifies times', async () => {
    const codeInfo = {
      source: 'gitlab',
      repo_name: 'novo-platform-backend',
      branch: '263.0.2.1/build/build_dev',
      commit_id: 'c5d3ce6d5680b373a5586676a69342c86c86b67e',
      commit_message: 'Merge branch x into y\n\nfeat(email): 同时失效token\n\nSee merge request !1095',
      author_name: '张亮',
    }
    const buildModules = [
      { service_name: 'novo-one', service_module: 'platform', code_info: [codeInfo] },
      { service_name: 'novo-one', service_module: 'infrastructure', code_info: [codeInfo] },
    ]
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      workflow_list: [
        {
          task_id: 4776,
          task_creator: '张亮-6845',
          workflow_name: 'static-code-scanning-and-build-deploy',
          workflow_display_name: '构建部署',
          status: 'waiting',
          reverted: false,
          create_time: 1788334627,
          start_time: 1788334632,
          stages: [
            { name: '构建', status: '', jobs: [{ name: '构建', type: 'zadig-build', status: '', error: '', service_modules: buildModules }] },
            {
              name: '部署',
              status: '',
              jobs: [
                { name: '部署-研发环境-客户自托管-0', type: 'zadig-deploy', status: '', error: '', service_modules: buildModules.map(m => ({ ...m, code_info: [] })), envs: { env_name: 'dev-client-hosted-0', env_alias: '研发-DC0' } },
                { name: '部署-研发环境平台托管0', type: 'zadig-deploy', status: '', error: '', service_modules: [], envs: { env_name: 'dev-platform-hosted-0', env_alias: '研发-DP0' } },
              ],
            },
          ],
        },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(new Context())
    const tasks = await service.fetchWorkflowTasks({ workflowName: 'static-code-scanning-and-build-deploy' })

    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(task.task_id).toBe(4776)
    expect(task.create_time_iso).toBe('2026-09-02T07:37:07Z')
    expect(task.start_time_iso).toBe('2026-09-02T07:37:12Z')

    const build = task.stages[0]!.jobs[0]!
    expect(build.service_modules).toEqual(['novo-one/platform', 'novo-one/infrastructure'])
    // The API repeats the identical code_info per service module; we keep one.
    expect(build.code_infos).toHaveLength(1)
    expect(build.code_infos[0]).toEqual({
      repo_name: 'novo-platform-backend',
      branch: '263.0.2.1/build/build_dev',
      commit_id: 'c5d3ce6d5680b373a5586676a69342c86c86b67e',
      commit_title: 'Merge branch x into y',
      author_name: '张亮',
    })

    const deployJobs = task.stages[1]!.jobs
    expect(deployJobs[0]!.deploy_env_name).toBe('dev-client-hosted-0')
    expect(deployJobs[0]!.deploy_env_alias).toBe('研发-DC0')
    expect(deployJobs[0]!.code_infos).toEqual([])
    expect(deployJobs[1]!.deploy_env_name).toBe('dev-platform-hosted-0')
    expect(deployJobs[1]!.deploy_env_alias).toBe('研发-DP0')
  })

  it('rejects malformed workflowtask payloads with the standard wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })))
    const service = makeService(new Context())
    await expect(service.fetchWorkflowTasks({ workflowName: 'wf' }))
      .rejects.toThrow('Zadig workflowtask 返回的数据格式无法解析')
  })

  it('wraps HTTP failures with 请求 Zadig API 失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    const service = makeService(new Context())
    await expect(service.fetchWorkflowTasks({ workflowName: 'wf' })).rejects.toThrow('请求 Zadig API 失败')
  })
})
