import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RocketMqService from '../src/index.ts'

/**
 * Golden tests pinned to `skills/mq-inspector/scripts/inspect.py`: the
 * login handshake (XSRF cookie/header pair, JSESSIONID extraction), session
 * check via /topic/list.query, the list/detail wire shapes asserted through
 * the fetch mock, and the 401/403 re-login retry. Time-argument parsing and
 * the slot contract live in `@dsh-sentry/mq-store`.
 */

const ENDPOINT = 'https://rocketmq.example.com'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function loginResponse(jsessionid = 'JS-1'): Response {
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `JSESSIONID=${jsessionid}; Path=/; HttpOnly`,
    },
  })
}

function makeService(ctx: Context, extra: Record<string, unknown> = {}): RocketMqService {
  return new RocketMqService(ctx, {
    endpoint: ENDPOINT,
    username: 'admin',
    password: 'secret',
    ...extra,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('RocketMqService provider slot', () => {
  it('occupies ctx.mqStore and exposes the console backend identity', async () => {
    const ctx = new Context()
    await ctx.plugin(RocketMqService, { endpoint: ENDPOINT, username: 'admin' })

    expect(ctx.mqStore.backendRef).toBe(`rocketmq-console:${ENDPOINT}`)

    await ctx.fiber.dispose()
  })
})

describe('session handshake — port of _login / _check_session / _ensure_session', () => {
  it('logs in with matching XSRF cookie and header, extracts JSESSIONID', async () => {
    const ctx = new Context()
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(loginResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(ctx)
    const session = await service.ensureSession()
    expect(session).toEqual({ jsessionid: 'JS-1', xsrfToken: expect.any(String) })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ENDPOINT}/login/login.do`)
    const headers = init.headers as Record<string, string>
    const xsrf = headers['x-xsrf-token']
    expect(headers['cookie']).toBe(`XSRF-TOKEN=${xsrf}`) // cookie and header must match
    expect(JSON.parse(init.body as string)).toEqual({ username: 'admin', password: 'secret' })

    await ctx.fiber.dispose()
  })

  it('reuses the cached session when /topic/list.query answers status 0', async () => {
    const ctx = new Context()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(loginResponse('JS-A')))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ status: 0 })))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ status: 0 })))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ status: 0, data: {} })))
    vi.stubGlobal('fetch', fetchMock)

    const service = makeService(ctx)
    await service.ensureSession()
    await service.ensureSession() // second call validates instead of re-logging-in
    await service.queryMessages({ topic: 't', beginMs: 1, endMs: 2 })

    expect(fetchMock).toHaveBeenCalledTimes(4) // login, check, check, query
    const checkUrl = (fetchMock.mock.calls[1] as unknown as [string])[0]
    expect(checkUrl).toBe(`${ENDPOINT}/topic/list.query`)

    await ctx.fiber.dispose()
  })
})

describe('queries — port of _query_messages / _query_message_detail', () => {
  it('aggregates the list page: content, totals, task state', async () => {
    const ctx = new Context()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(loginResponse()))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({
        status: 0,
        data: {
          taskId: 'task-9',
          truncated: true,
          scanned: 5000,
          page: {
            content: [{ msgId: 'M1' }, { msgId: 'M2' }],
            totalElements: 42,
            totalPages: 5,
          },
        },
      })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeService(ctx).queryMessages({
      topic: 'topic_user',
      beginMs: 1,
      endMs: 2,
      pageSize: 2,
      keyword: 'err',
    })
    expect(result.status).toBe(0)
    expect(result.errMsg).toBeNull()
    expect(result.messages).toEqual([{ msgId: 'M1' }, { msgId: 'M2' }])
    expect(result.totalElements).toBe(42)
    expect(result.totalPages).toBe(5)
    expect(result.taskId).toBe('task-9')
    expect(result.truncated).toBe(true)
    expect(result.scanned).toBe(5000)

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe(`${ENDPOINT}/message/queryMessagePageByTopic.query`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      topic: 'topic_user', begin: 1, end: 2, pageNum: 1, pageSize: 2, taskId: '', keyword: 'err',
    })

    await ctx.fiber.dispose()
  })

  it('aggregates the detail: message view and track list', async () => {
    const ctx = new Context()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(loginResponse()))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({
        status: 0,
        data: {
          messageView: { msgId: 'M1', body: 'hello' },
          messageTrackList: [
            { consumerGroup: 'g1', trackType: 'CONSUMED' },
            { consumerGroup: 'g2', trackType: 'NOT_ONLINE' },
          ],
        },
      })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeService(ctx).queryMessageDetail({ topic: 'topic_user', msgId: 'M1' })
    expect(result.messageView).toEqual({ msgId: 'M1', body: 'hello' })
    expect(result.messageTrackList).toEqual([
      { consumerGroup: 'g1', trackType: 'CONSUMED' },
      { consumerGroup: 'g2', trackType: 'NOT_ONLINE' },
    ])

    const [url] = fetchMock.mock.calls[1] as unknown as [string]
    expect(url).toBe(`${ENDPOINT}/message/viewMessage.query?msgId=M1&topic=topic_user`)

    await ctx.fiber.dispose()
  })

  it('re-logins once on 401 and retries the query — port of _query_with_fallback', async () => {
    const ctx = new Context()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(loginResponse('JS-OLD')))
      .mockImplementationOnce(() => Promise.resolve(new Response('expired', { status: 401 })))
      .mockImplementationOnce(() => Promise.resolve(loginResponse('JS-NEW')))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ status: 0, data: { page: { content: [] } } })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await makeService(ctx).queryMessages({ topic: 't', beginMs: 1, endMs: 2 })
    expect(result.status).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // The retried query carries the NEW session cookie.
    const [, retryInit] = fetchMock.mock.calls[3] as unknown as [string, RequestInit]
    expect((retryInit.headers as Record<string, string>)['cookie']).toContain('JSESSIONID=JS-NEW')

    await ctx.fiber.dispose()
  })
})
