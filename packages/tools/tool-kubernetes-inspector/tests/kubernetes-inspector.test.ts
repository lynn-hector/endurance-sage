import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  KubernetesStore,
  type KubernetesListQuery,
  type KubernetesListResult,
  type KubernetesLogQuery,
  type KubernetesObject,
} from '@dsh-sentry/kubernetes-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as kubernetesInspector from '../src/index.ts'

/**
 * Fake-Provider contract test against the Definition: the tools must talk
 * to the `ctx.kubernetesStore` seam only (never the Provider class), never
 * expose a context/cluster parameter, and stamp every evidence branch
 * (success / error) with the Provider's own backend identity plus the
 * session env marker.
 */

class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(): unknown[] {
    return []
  }

  async assemble(): Promise<{ sections: unknown[] }> {
    return { sections: [] }
  }
}

/** Session Provider router stub: leases the globally mounted service under a fixed env label. */
class StubEnvProviders extends Service {
  constructor(ctx: Context, private readonly options: { env: string }) {
    super(ctx, 'envProviders')
  }

  async forCall(): Promise<unknown> {
    const ctx = this.ctx
    return {
      env: this.options.env,
      unavailableLegs: [],
      release: async () => {},
      require(slot: string): unknown {
        const instance = ctx.get(slot)
        if (instance === undefined) throw new Error(`stub lease: ${slot} 未加载`)
        return instance
      },
    }
  }
}

/** Session router stub that always fails — exercises the unresolved-route evidence branch. */
class FailingEnvProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'envProviders')
  }

  async forCall(): Promise<never> {
    throw new Error('环境 test 的 kubernetesStore Provider 不可用: 网络不可达')
  }
}

const FAKE_BACKEND_REF = 'kubernetes:tst-platform-hosted-1@http://kubernetes-mcp.test/mcp'

class FakeKubernetesStore extends KubernetesStore {
  podLists: Array<KubernetesListQuery & { namespace: string }> = []
  podDetails: Array<{ name: string; namespace: string }> = []
  logCalls: Array<{ name: string; query: KubernetesLogQuery & { namespace: string } }> = []
  eventCalls: KubernetesListQuery[] = []
  resourceLists: Array<{ apiVersion: string; kind: string; query: KubernetesListQuery }> = []
  resourceGets: Array<{ apiVersion: string; kind: string; name: string; namespace: string | undefined }> = []
  error?: Error

  override get backendRef(): string {
    return FAKE_BACKEND_REF
  }

  override get configured(): boolean {
    return true
  }

  override get context(): string {
    return 'tst-platform-hosted-1'
  }

  override get namespace(): string {
    return 'novo-one'
  }

  override async listPods(query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    this.podLists.push({ ...query, namespace: query.namespace ?? 'novo-one' })
    if (this.error) throw this.error
    return {
      items: [
        { Name: 'commctl-config-6c7679b978-ghj6s', Namespace: 'novo-one', Status: 'Running', Ready: '1/1', Restarts: '0', Age: '4h', Node: 'node-a' },
        { Name: 'commctl-sip-5d8f7c9b4-x2plm', Namespace: 'novo-one', Status: 'CrashLoopBackOff', Ready: '0/1', Restarts: '12 (5m ago)', Age: '2d', Node: 'node-b' },
      ],
      continue: 'tok-9',
      remainingItemCount: 37,
      text: '# pods table',
    }
  }

  override async getPod(name: string, namespace?: string): Promise<KubernetesObject> {
    this.podDetails.push({ name, namespace: namespace ?? 'novo-one' })
    if (this.error) throw this.error
    return {
      object: {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, namespace: namespace ?? 'novo-one' },
        spec: { nodeName: 'node-a', containers: [{ name: 'commctl-config', image: 'hub.yeastardigital.com/novo-one/commctl-config:tag' }] },
        status: { phase: 'Running' },
      },
      text: 'pod object',
    }
  }

  override async getPodLogs(name: string, query: KubernetesLogQuery = {}): Promise<string> {
    this.logCalls.push({ name, query: { ...query, namespace: query.namespace ?? 'novo-one' } })
    if (this.error) throw this.error
    return '{"level":"info","msg":"serving"}\n{"level":"error","msg":"panic: runtime error"}'
  }

  override async listEvents(query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    this.eventCalls.push(query)
    if (this.error) throw this.error
    return {
      items: [
        { Namespace: 'novo-one', Type: 'Warning', Reason: 'BackOff', InvolvedObject: 'commctl-sip-5d8f7c9b4-x2plm', Message: 'Back-off restarting failed container' },
        { Namespace: 'novo-one', Type: 'Normal', Reason: 'Pulled', InvolvedObject: 'commctl-config-6c7679b978-ghj6s', Message: 'Container image already present' },
      ],
      continue: null,
      remainingItemCount: null,
      text: 'events table',
    }
  }

  override async getResource(apiVersion: string, kind: string, name: string, namespace?: string): Promise<KubernetesObject> {
    this.resourceGets.push({ apiVersion, kind, name, namespace })
    if (this.error) throw this.error
    return {
      object: {
        apiVersion,
        kind,
        metadata: { name, namespace: namespace ?? 'novo-one' },
        spec: { replicas: 2 },
        status: { readyReplicas: 2 },
      },
      text: 'object',
    }
  }

  override async listResources(apiVersion: string, kind: string, query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    this.resourceLists.push({ apiVersion, kind, query })
    if (this.error) throw this.error
    return {
      items: [{ Name: 'commctl-config', Namespace: 'novo-one', Ready: '2/2', Available: 2, Images: 'hub.yeastardigital.com/novo-one/commctl-config:tag' }],
      continue: null,
      remainingItemCount: null,
      text: 'resource table',
    }
  }
}

interface Envelope {
  evidence: {
    data: Record<string, unknown>
    refs?: string[]
    confidence: number
    summary: string
  }
}

let ctx: Context
let service: FakeKubernetesStore

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeKubernetesStore)
  service = ctx.kubernetesStore as FakeKubernetesStore
  await ctx.plugin(StubEnvProviders, { env: 'test' })
  await ctx.plugin(kubernetesInspector)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

type ToolName = 'sentry_query_k8s_pods' | 'sentry_read_k8s_pod_logs' | 'sentry_list_k8s_events' | 'sentry_query_k8s_resource'

function tool(name: ToolName) {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-kubernetes-inspector KubernetesStore Consumer', () => {
  it('registers exactly the four curated read-only tools', () => {
    for (const name of ['sentry_query_k8s_pods', 'sentry_read_k8s_pod_logs', 'sentry_list_k8s_events', 'sentry_query_k8s_resource']) {
      expect(ctx.tools.get(name), name).not.toBeUndefined()
    }
  })

  it('lists pods through the seam with env + Provider identity stamped', async () => {
    const output = await tool('sentry_query_k8s_pods').execute({}, {} as never) as Envelope

    expect(service.podLists).toEqual([{ namespace: 'novo-one', limit: 100 }])
    expect(output.evidence.data).toMatchObject({
      env: 'test',
      backend_ref: FAKE_BACKEND_REF,
      context: 'tst-platform-hosted-1',
      namespace: 'novo-one',
      mode: 'pod_list',
      item_count: 2,
      continue: 'tok-9',
      remaining_item_count: 37,
    })
    expect(output.evidence.summary).toContain('1 个非 Running')
    expect(output.evidence.refs).toEqual([FAKE_BACKEND_REF, 'env:test:kubernetes'])
  })

  it('routes pod detail mode and surfaces the phase', async () => {
    const output = await tool('sentry_query_k8s_pods').execute({ pod: 'commctl-config-6c7679b978-ghj6s' }, {} as never) as Envelope

    expect(service.podDetails).toEqual([{ name: 'commctl-config-6c7679b978-ghj6s', namespace: 'novo-one' }])
    expect(output.evidence.data).toMatchObject({
      mode: 'pod_detail',
      pod: 'commctl-config-6c7679b978-ghj6s',
      phase: 'Running',
    })
    expect(output.evidence.data['object']).toMatchObject({ kind: 'Pod' })
  })

  it('passes selectors, limit clamp and continuation through list mode', async () => {
    await tool('sentry_query_k8s_pods').execute({
      namespace: 'middleware',
      labelSelector: 'app.kubernetes.io/name=commctl-config',
      limit: 9999,
      continueToken: 'tok-1',
    }, {} as never)

    expect(service.podLists).toEqual([{
      namespace: 'middleware',
      labelSelector: 'app.kubernetes.io/name=commctl-config',
      limit: 200,
      continue: 'tok-1',
    }])
  })

  it('reads pod logs with tail clamping and previous-instance flag', async () => {
    const output = await tool('sentry_read_k8s_pod_logs').execute({
      pod: 'commctl-sip-5d8f7c9b4-x2plm',
      tail: 5000,
      previous: true,
    }, {} as never) as Envelope

    expect(service.logCalls).toEqual([{
      name: 'commctl-sip-5d8f7c9b4-x2plm',
      query: { namespace: 'novo-one', tail: 2000, previous: true },
    }])
    expect(output.evidence.data).toMatchObject({
      env: 'test',
      mode: 'pod_logs',
      pod: 'commctl-sip-5d8f7c9b4-x2plm',
      previous: true,
      line_count: 2,
    })
    expect(output.evidence.data['logs']).toContain('panic: runtime error')
  })

  it('lists events cluster-wide by default and counts warnings', async () => {
    const output = await tool('sentry_list_k8s_events').execute({}, {} as never) as Envelope

    expect(service.eventCalls).toEqual([{ limit: 100 }])
    expect(output.evidence.data).toMatchObject({
      namespace: null,
      mode: 'event_list',
      item_count: 2,
      warning_count: 1,
    })
    expect(output.evidence.summary).toContain('1 条 Warning')
  })

  it('scopes events to a namespace when given', async () => {
    await tool('sentry_list_k8s_events').execute({ namespace: 'middleware', fieldSelector: 'type=Warning' }, {} as never)
    expect(service.eventCalls).toEqual([{ namespace: 'middleware', fieldSelector: 'type=Warning', limit: 100 }])
  })

  it('fetches one full resource object in detail mode', async () => {
    const output = await tool('sentry_query_k8s_resource').execute({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      name: 'commctl-config',
    }, {} as never) as Envelope

    expect(service.resourceGets).toEqual([{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'commctl-config', namespace: undefined }])
    expect(output.evidence.data).toMatchObject({
      mode: 'resource_detail',
      api_version: 'apps/v1',
      kind: 'Deployment',
      name: 'commctl-config',
      object: { kind: 'Deployment', status: { readyReplicas: 2 } },
    })
  })

  it('lists resources with the default row cap', async () => {
    const output = await tool('sentry_query_k8s_resource').execute({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    }, {} as never) as Envelope

    expect(service.resourceLists).toEqual([{ apiVersion: 'apps/v1', kind: 'Deployment', query: { limit: 50 } }])
    expect(output.evidence.data).toMatchObject({ mode: 'resource_list', item_count: 1 })
  })

  it('keeps Provider failures inside the evidence envelope with the identity intact', async () => {
    service.error = new Error('请求 Kubernetes MCP 失败: HTTP 500: boom')
    const output = await tool('sentry_query_k8s_pods').execute({}, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({
      env: 'test',
      backend_ref: FAKE_BACKEND_REF,
      error: '请求 Kubernetes MCP 失败: HTTP 500: boom',
    })
    expect(output.evidence.refs).toEqual([FAKE_BACKEND_REF, 'env:test:kubernetes'])
  })

  it('reports an unresolved route as kubernetes:unresolved without losing the envelope', async () => {
    // Lease routing failure: no Provider mounted. Fresh context, failing router.
    const bareCtx = new Context()
    await bareCtx.plugin(StubSystemPrompt)
    await bareCtx.plugin(ToolRuntime)
    await bareCtx.plugin(FailingEnvProviders)
    await bareCtx.plugin(kubernetesInspector)
    try {
      const output = await bareCtx.tools.get('sentry_list_k8s_events')!.execute({}, {} as never) as Envelope
      expect(output.evidence.confidence).toBe(0)
      expect(output.evidence.data).toMatchObject({
        backend_ref: 'kubernetes:unresolved',
        env: 'unknown',
        error: '环境 test 的 kubernetesStore Provider 不可用: 网络不可达',
      })
    } finally {
      await bareCtx.fiber.dispose()
    }
  })
})
