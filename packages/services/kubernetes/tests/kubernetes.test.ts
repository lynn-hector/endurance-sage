import { Context } from '@deepseek-ai/cordis'
import { KubernetesStore } from '@dsh-sentry/kubernetes-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KubernetesService, { parseRpcBody } from '../src/index.ts'

/**
 * Golden tests against the probed gateway contract (kubernetes-mcp-server
 * v0.0.69, streamable HTTP, protocol 2025-06-18): SSE-or-JSON bodies, the
 * mcp-session-id handshake, unconditional context injection, seam-shape
 * result mapping, tool-level error envelopes, and the one-shot session
 * recovery after a gateway restart (HTTP 404).
 */

const ENDPOINT = 'http://kubernetes-mcp.test/mcp'
const ENDPOINT_REF = 'KUBERNETES_MCP_ENDPOINT'
const CONTEXT = 'tst-platform-hosted-1'

function sse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

function json(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

interface FetchCall {
  body: Record<string, unknown>
  headers: Record<string, string>
}

/** Arguments of one recorded tools/call, for wire-level assertions. */
function toolCallArguments(calls: FetchCall[], index = 0): Record<string, unknown> {
  const found = calls.filter(call => call.body['method'] === 'tools/call')[index]
  const params = found?.body['params'] as { name: string; arguments: Record<string, unknown> }
  return params.arguments
}

/**
 * A stateful gateway stub: initialize mints session ids, calls echo their
 * arguments back through a marker so tests can assert what crossed the wire.
 */
function gatewayStub(options: { failFirstSession?: boolean } = {}) {
  const calls: FetchCall[] = []
  let sessionCounter = 0
  const sessionsDropped: string[] = []
  const mock = vi.fn(async (_url: string | URL, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    const headers = init.headers as Record<string, string>
    calls.push({ body, headers })
    const method = body['method']
    if (method === 'initialize') {
      sessionCounter += 1
      return sse({
        jsonrpc: '2.0',
        id: body['id'],
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'kubernetes-mcp-server', version: 'v0.0.69' } },
      }, { 'mcp-session-id': `SID-${sessionCounter}` })
    }
    if (method === 'notifications/initialized') return new Response('', { status: 202 })
    const session = headers['mcp-session-id'] ?? ''
    if (session === '' || sessionsDropped.includes(session)) {
      return new Response('session not found', { status: 404 })
    }
    if (options.failFirstSession === true && session === 'SID-1') {
      sessionsDropped.push(session)
      return new Response('session expired', { status: 404 })
    }
    if (method === 'tools/call') {
      const params = body['params'] as { name: string; arguments: Record<string, unknown> }
      return sse({
        jsonrpc: '2.0',
        id: body['id'],
        result: {
          content: [{ type: 'text', text: `echo ${params.name}` }],
          structuredContent: { items: [], echoed: params.arguments },
        },
      })
    }
    return json({ jsonrpc: '2.0', id: body['id'], result: {} })
  })
  return { mock, calls }
}

function makeService(extra: Record<string, unknown> = {}): KubernetesService {
  vi.stubEnv(ENDPOINT_REF, ENDPOINT)
  return new KubernetesService(new Context(), {
    endpointRef: ENDPOINT_REF,
    context: CONTEXT,
    ...extra,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('parseRpcBody — SSE or JSON', () => {
  it('parses a plain JSON body', () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}'))
      .toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('parses a text/event-stream frame', () => {
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n'))
      .toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } })
  })

  it('rejects an empty body', () => {
    expect(() => parseRpcBody('   \n')).toThrow('响应体为空')
  })
})

describe('KubernetesService identity', () => {
  it('exposes the bound context; the endpoint and backendRef resolve after the first handshake', () => {
    const service = makeService()
    expect(service.context).toBe(CONTEXT)
    expect(service.namespace).toBe('novo-one')
    expect(service.configured).toBe(true)
    expect(service.endpoint).toBeUndefined()
    expect(service.backendRef).toBe(`kubernetes:${CONTEXT}@unresolved`)
  })

  it('resolves the gateway URL from the endpointRef credential at the first handshake', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    await service.listPods({})

    expect(service.endpoint).toBe(ENDPOINT)
    expect(service.backendRef).toBe(`kubernetes:${CONTEXT}@${ENDPOINT}`)
  })

  it('fails with a leg-local hint when the endpoint credential has no value', async () => {
    vi.stubEnv(ENDPOINT_REF, '')
    vi.stubGlobal('fetch', vi.fn())
    const service = new KubernetesService(new Context(), { endpointRef: ENDPOINT_REF, context: CONTEXT })
    await expect(service.listPods({})).rejects.toThrow(`凭据 ${ENDPOINT_REF} 缺值`)
  })

  it('reports itself unconfigured without endpointRef or context', () => {
    expect(new KubernetesService(new Context()).configured).toBe(false)
    expect(new KubernetesService(new Context(), { endpointRef: ENDPOINT_REF, context: '' }).configured).toBe(false)
  })

  it('occupies the kubernetesStore seam slot when plugged', async () => {
    const ctx = new Context()
    await ctx.plugin(KubernetesService, { endpointRef: ENDPOINT_REF, context: CONTEXT })
    expect(ctx.kubernetesStore).toBeInstanceOf(KubernetesStore)
    expect(ctx.kubernetesStore.context).toBe(CONTEXT)
    expect(ctx.kubernetesStore.backendRef).toBe(`kubernetes:${CONTEXT}@unresolved`)
    await ctx.fiber.dispose()
  })
})

describe('MCP handshake and context injection', () => {
  it('lazily initializes once, threads the session id, and pins the context into every call', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    const result = await service.listPods({ namespace: 'kube-system', limit: 10 })

    expect(toolCallArguments(gateway.calls)).toEqual({ namespace: 'kube-system', limit: 10, context: CONTEXT })
    expect(result.items).toEqual([])
    const initialize = gateway.calls.find(call => call.body['method'] === 'initialize')
    expect(initialize?.headers['mcp-session-id']).toBeUndefined()
    const calls = gateway.calls.filter(call => call.body['method'] === 'tools/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers['mcp-session-id']).toBe('SID-1')
    expect(gateway.calls.filter(call => call.body['method'] === 'initialize')).toHaveLength(1)
  })

  it('overrides a caller-supplied context — the Provider owns the environment boundary', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    await service.callTool('pods_get', { name: 'p', namespace: 'novo-one', context: 'pro-br-saas-aws-eks-novo' })

    expect(toolCallArguments(gateway.calls)).toMatchObject({ context: CONTEXT })
  })

  it('single-flights concurrent first calls through one initialize', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    await Promise.all([service.listPods({}), service.listEvents({})])

    expect(gateway.calls.filter(call => call.body['method'] === 'initialize')).toHaveLength(1)
  })

  it('sends the Bearer token on every request once a ref resolves', async () => {
    vi.stubEnv('KUBERNETES_MCP_TOKEN', 'tok-1')
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService({ tokenRef: 'KUBERNETES_MCP_TOKEN' })
    await service.listPods({})

    for (const call of gateway.calls) {
      expect(call.headers['authorization']).toBe('Bearer tok-1')
    }
  })
})

describe('seam result mapping', () => {
  it('maps a list envelope to items / continue / remainingItemCount and keeps the text table', async () => {
    const mock = vi.fn(async (_url: string | URL, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      if (body['method'] === 'initialize') {
        return sse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'SID-1' })
      }
      if (body['method'] === 'notifications/initialized') return new Response('', { status: 202 })
      return sse({
        jsonrpc: '2.0',
        id: body['id'],
        result: {
          content: [{ type: 'text', text: '# pods table' }],
          structuredContent: {
            items: [
              { Name: 'commctl-config-6c7679b978-ghj6s', Status: 'Running' },
              { Name: 'commctl-sip-5d8f7c9b4-x2plm', Status: 'CrashLoopBackOff' },
            ],
            continue: 'tok-9',
            remainingItemCount: 37,
          },
        },
      })
    })
    vi.stubGlobal('fetch', mock)

    const service = makeService()
    const result = await service.listPods({ namespace: 'novo-one' })

    expect(result).toEqual({
      items: [
        { Name: 'commctl-config-6c7679b978-ghj6s', Status: 'Running' },
        { Name: 'commctl-sip-5d8f7c9b4-x2plm', Status: 'CrashLoopBackOff' },
      ],
      continue: 'tok-9',
      remainingItemCount: 37,
      text: '# pods table',
    })
  })

  it('maps a get envelope to the seam object shape', async () => {
    const mock = vi.fn(async (_url: string | URL, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      if (body['method'] === 'initialize') {
        return sse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'SID-1' })
      }
      if (body['method'] === 'notifications/initialized') return new Response('', { status: 202 })
      return sse({
        jsonrpc: '2.0',
        id: body['id'],
        result: {
          content: [{ type: 'text', text: 'pod object' }],
          structuredContent: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod-1' }, status: { phase: 'Running' } },
        },
      })
    })
    vi.stubGlobal('fetch', mock)

    const service = makeService()
    const result = await service.getPod('pod-1', 'novo-one')

    expect(result.object).toMatchObject({ kind: 'Pod', status: { phase: 'Running' } })
    expect(result.text).toBe('pod object')
  })

  it('returns the log body as text when the tool emits no structuredContent', async () => {
    const mock = vi.fn(async (_url: string | URL, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      if (body['method'] === 'initialize') {
        return sse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'SID-1' })
      }
      if (body['method'] === 'notifications/initialized') return new Response('', { status: 202 })
      const params = (body['params'] as { name: string; arguments: Record<string, unknown> }).arguments
      return sse({
        jsonrpc: '2.0',
        id: body['id'],
        result: { content: [{ type: 'text', text: `{"level":"info","msg":"${String(params['name'])}"}` }] },
      })
    })
    vi.stubGlobal('fetch', mock)

    const service = makeService()
    const text = await service.getPodLogs('commctl-config-6c7679b978-ghj6s', { tail: 3 })

    expect(text).toContain('"msg":"commctl-config-6c7679b978-ghj6s"')
    const call = mock.mock.calls.map(args => JSON.parse(args[1].body as string) as Record<string, unknown>)
      .find(body => body['method'] === 'tools/call')?.['params'] as { name: string; arguments: Record<string, unknown> }
    expect(call.name).toBe('pods_log')
    expect(call.arguments).toMatchObject({ name: 'commctl-config-6c7679b978-ghj6s', tail: 3, namespace: 'novo-one' })
    expect(call.arguments).not.toHaveProperty('previous')
  })

  it('throws the tool-level error text when the gateway answers isError', async () => {
    const mock = vi.fn(async (_url: string | URL, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      if (body['method'] === 'initialize') {
        return sse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'SID-1' })
      }
      if (body['method'] === 'notifications/initialized') return new Response('', { status: 202 })
      return sse({
        jsonrpc: '2.0',
        id: body['id'],
        result: { content: [{ type: 'text', text: 'resource not allowed: /v1, Kind=Secret' }], isError: true },
      })
    })
    vi.stubGlobal('fetch', mock)

    const service = makeService()
    await expect(service.getResource('v1', 'Secret', 'db-credentials', 'novo-one'))
      .rejects.toThrow('Kubernetes MCP 工具 resources_get 返回错误: resource not allowed: /v1, Kind=Secret')
  })

  it('wraps JSON-RPC error responses with the standard prefix', async () => {
    const mock = vi.fn(async (_url: string | URL, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      if (body['method'] === 'initialize') {
        return sse({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'SID-1' })
      }
      if (body['method'] === 'notifications/initialized') return new Response('', { status: 202 })
      return json({ jsonrpc: '2.0', id: body['id'], error: { code: -32602, message: 'Invalid params' } })
    })
    vi.stubGlobal('fetch', mock)

    const service = makeService()
    await expect(service.listPods({})).rejects.toThrow('请求 Kubernetes MCP 失败: Invalid params')
  })
})

describe('session recovery', () => {
  it('re-initializes once after the gateway dropped the session (HTTP 404)', async () => {
    const gateway = gatewayStub({ failFirstSession: true })
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    const result = await service.listPods({})

    expect(toolCallArguments(gateway.calls, 1)).toEqual({ namespace: 'novo-one', context: CONTEXT })
    expect(result.text).toBe('echo pods_list_in_namespace')
    expect(gateway.calls.filter(call => call.body['method'] === 'initialize')).toHaveLength(2)
    const retried = gateway.calls.filter(call => call.body['method'] === 'tools/call')
    expect(retried).toHaveLength(2)
    expect(retried[0]?.headers['mcp-session-id']).toBe('SID-1')
    expect(retried[1]?.headers['mcp-session-id']).toBe('SID-2')
  })

  it('wraps transport failures with 请求 Kubernetes MCP 失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))
    const service = makeService()
    await expect(service.listPods({})).rejects.toThrow('请求 Kubernetes MCP 失败: connect ECONNREFUSED')
  })

  it('fails the handshake when initialize returns no mcp-session-id header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ jsonrpc: '2.0', id: 1, result: {} })))
    const service = makeService()
    await expect(service.listPods({})).rejects.toThrow('缺少 mcp-session-id 头')
  })
})

describe('curated call builders', () => {
  it('listEvents omits namespace when unset — cluster-wide by gateway semantics', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    await service.listEvents({ fieldSelector: 'type=Warning', limit: 20 })

    const params = gateway.calls.find(call => call.body['method'] === 'tools/call')?.body['params'] as { name: string; arguments: Record<string, unknown> }
    expect(params.name).toBe('events_list')
    expect(params.arguments).toEqual({ fieldSelector: 'type=Warning', limit: 20, context: CONTEXT })
  })

  it('listResources passes through selectors and the continuation token', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService()
    await service.listResources('apps/v1', 'Deployment', {
      namespace: 'novo-one',
      labelSelector: 'app.kubernetes.io/part-of=novo-one',
      limit: 50,
      continue: 'tok-1',
    })

    const params = gateway.calls.find(call => call.body['method'] === 'tools/call')?.body['params'] as { name: string; arguments: Record<string, unknown> }
    expect(params.name).toBe('resources_list')
    expect(params.arguments).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      namespace: 'novo-one',
      labelSelector: 'app.kubernetes.io/part-of=novo-one',
      limit: 50,
      continue: 'tok-1',
      context: CONTEXT,
    })
  })

  it('getPod and getPodLogs default the namespace to the configured one', async () => {
    const gateway = gatewayStub()
    vi.stubGlobal('fetch', gateway.mock)

    const service = makeService({ namespace: 'middleware' })
    await service.getPod('pod-1')
    await service.getPodLogs('pod-1', { previous: true })

    const namespaces = gateway.calls
      .filter(call => call.body['method'] === 'tools/call')
      .map(call => ((call.body['params'] as { arguments: Record<string, unknown> }).arguments['namespace']))
    expect(namespaces).toEqual(['middleware', 'middleware'])
  })
})
