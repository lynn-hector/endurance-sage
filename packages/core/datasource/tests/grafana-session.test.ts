import { afterEach, describe, expect, it, vi } from 'vitest'
import { authRetryGetJson, GrafanaSessionKeeper } from '../src/grafana-session.ts'

function loginOk(session = 'sess-abc'): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'content-cookie': '', 'set-cookie': `grafana_session=${session}; Path=/; Max-Age=2592000` },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('GrafanaSessionKeeper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs in via POST /login and carries the grafana_session cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginOk('sess-1'))
    vi.stubGlobal('fetch', fetchMock)

    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => ({ username: 'admin', password: 'p' }),
    })
    const auth = await keeper.authHeaders()
    expect(auth).toEqual({ headers: { cookie: 'grafana_session=sess-1' }, retriable: true })
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://grafana.example.com/login')
    expect(init.method).toBe('POST')

    // 第二次调用复用缓存 session，不再登录
    await keeper.authHeaders()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns empty non-retriable headers without credentials', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => undefined,
    })
    expect(await keeper.authHeaders()).toEqual({ headers: {}, retriable: false })
  })

  it('clearSession forces the next authHeaders into a fresh login', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginOk('sess-2'))
    vi.stubGlobal('fetch', fetchMock)
    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => ({ username: 'admin', password: 'p' }),
    })
    await keeper.authHeaders()
    keeper.clearSession()
    const auth = await keeper.authHeaders()
    expect(auth.headers['cookie']).toBe('grafana_session=sess-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('wraps transport failures with the service-trace error wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net down')))
    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => ({ username: 'admin', password: 'p' }),
    })
    await expect(keeper.authHeaders()).rejects.toThrow('Grafana 登录连接失败: net down')
  })
})

describe('authRetryGetJson（Grafana 会话代理 GET 的统一包装）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function keeperWithCredentials(): GrafanaSessionKeeper {
    return new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => ({ username: 'u', password: 'p' }),
    })
  }

  it('会话被拒（401）→ 清会话重登一次并成功返回 JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk('sess-1'))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(loginOk('sess-2'))
      .mockResolvedValueOnce(jsonResponse({ alerts: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const raw = await authRetryGetJson(keeperWithCredentials(), 'https://grafana.example.com/api/x', { label: 'Alertmanager' })
    expect(raw).toEqual({ alerts: [] })
    expect(fetchMock).toHaveBeenCalledTimes(4) // login → GET 401 → login → GET 200
  })

  it('非认证错误（500）不重试，直接抛出且文案带 label', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk('sess-1'))
      .mockResolvedValueOnce(jsonResponse({ err: 'boom' }, 500))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      authRetryGetJson(keeperWithCredentials(), 'https://grafana.example.com/api/x', { label: 'Alertmanager' }),
    ).rejects.toThrow('Alertmanager HTTP 500')
    expect(fetchMock).toHaveBeenCalledTimes(2) // login + 1 GET，无重试
  })

  it('500 错误体里嵌着 "401" 数字串（epoch/request id）也不误判为会话失效——判定用结构化状态码，不解析消息文本', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(loginOk('sess-1'))
      .mockResolvedValueOnce(jsonResponse({ detail: 'upstream failed at 1760000004030, req=403a' }, 500))
    vi.stubGlobal('fetch', fetchMock)
    const keeper = keeperWithCredentials()

    await expect(
      authRetryGetJson(keeper, 'https://grafana.example.com/api/x', { label: 'Alertmanager' }),
    ).rejects.toThrow('HTTP 500')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 只有 login + 1 GET——没有清会话重登
    // 健康会话未被丢弃：同一个 keeper 的下一次请求复用 sess-1，不再登录
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await authRetryGetJson(keeper, 'https://grafana.example.com/api/x', { label: 'Alertmanager' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('匿名（无凭据，retriable=false）401 也不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401))
    vi.stubGlobal('fetch', fetchMock)
    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => undefined,
    })
    await expect(
      authRetryGetJson(keeper, 'https://grafana.example.com/api/x', { label: 'Alertmanager' }),
    ).rejects.toThrow('401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('authSession（自组 cookie 头的消费方形态，如 service-trace）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('返回 session 值与 retriable: true；缓存复用不再登录', async () => {
    const fetchMock = vi.fn().mockResolvedValue(loginOk('sess-a'))
    vi.stubGlobal('fetch', fetchMock)
    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => ({ username: 'u', password: 'p' }),
    })
    expect(await keeper.authSession()).toEqual({ session: 'sess-a', retriable: true })
    expect(await keeper.authSession()).toEqual({ session: 'sess-a', retriable: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('无凭据返回 session: undefined、retriable: false', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: 'https://grafana.example.com',
      resolveCredentials: async () => undefined,
    })
    expect(await keeper.authSession()).toEqual({ session: undefined, retriable: false })
  })
})
