import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlertmanagerService } from '../src/index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1]![0] as string
}

describe('AlertmanagerService — grafana proxy URLs and envelope passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('grafanaEndpoint 必填：缺失时 schema 校验失败（配置期报错，而非运行期 Failed to parse URL）', () => {
    expect(() =>
      // @ts-expect-error 故意缺 grafanaEndpoint——TS 已知不完整，这里验证 schema 层在配置期拒绝
      AlertmanagerService.Config({ datasourceUid: 'alertmanager' }),
    ).toThrow()
  })

  it('listAlerts GETs the v2 alerts legacy-proxy URL and returns the array as-is', async () => {
    const ALERTS = [{ labels: { alertname: 'GoGrpcP95LatencyHigh' }, status: { state: 'active' } }]
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ALERTS))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const service = new AlertmanagerService(ctx, {
      grafanaEndpoint: 'https://grafana.example.com/',
      datasourceUid: 'alertmanager',
    })
    const raw = await service.listAlerts()
    expect(lastUrl(fetchMock)).toBe(
      'https://grafana.example.com/api/datasources/proxy/uid/alertmanager/api/v2/alerts',
    )
    expect(raw).toEqual(ALERTS)
  })

  it('listSilences GETs the v2 silences legacy-proxy URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const service = new AlertmanagerService(ctx, { grafanaEndpoint: 'https://grafana.example.com' })
    await service.listSilences()
    expect(lastUrl(fetchMock)).toBe(
      'https://grafana.example.com/api/datasources/proxy/uid/alertmanager/api/v2/silences',
    )
  })

  it('buildAlertsRequest/buildSilencesRequest honor a custom datasource uid', () => {
    const service = new AlertmanagerService(new Context(), {
      grafanaEndpoint: 'https://grafana.example.com',
      datasourceUid: 'am-custom',
    })
    expect(service.buildAlertsRequest().url).toContain('/proxy/uid/am-custom/api/v2/alerts')
    expect(service.buildSilencesRequest().url).toContain('/proxy/uid/am-custom/api/v2/silences')
  })

  it('re-logins once when the cached session is rejected (401)', async () => {
    const login = new Response('{}', {
      status: 200,
      headers: { 'set-cookie': 'grafana_session=s1; Path=/; Max-Age=2592000' },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(login)                                   // 首次登录
      .mockResolvedValueOnce(new Response('denied', { status: 401 })) // 首次查询被拒
      .mockResolvedValueOnce(login)                                   // 重登（新 session 同值，测试只看次数）
      .mockResolvedValueOnce(jsonResponse([]))                        // 重试成功
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const service = new AlertmanagerService(ctx, {
      grafanaEndpoint: 'https://grafana.example.com',
      username: 'admin',
      password: 'p',
    })
    await expect(service.listAlerts()).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('wraps non-2xx with the Alertmanager error wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })))
    const ctx = new Context()
    const service = new AlertmanagerService(ctx, { grafanaEndpoint: 'https://grafana.example.com' })
    await expect(service.listAlerts()).rejects.toThrow('Alertmanager HTTP 503: boom')
  })
})
