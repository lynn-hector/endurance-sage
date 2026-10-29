import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  KubernetesStore,
  type KubernetesListQuery,
  type KubernetesListResult,
  type KubernetesObject,
} from '../src/index.ts'

class FakeKubernetesStore extends KubernetesStore {
  override get backendRef(): string {
    return 'fake:kubernetes'
  }

  override get configured(): boolean {
    return true
  }

  override get context(): string {
    return 'fake-context'
  }

  override get namespace(): string {
    return 'novo-one'
  }

  override async listPods(query: KubernetesListQuery = {}): Promise<KubernetesListResult> {
    return {
      items: [{ Name: 'pod-1', Namespace: query.namespace ?? this.namespace }],
      continue: query.continue !== undefined ? 'next-tok' : null,
      remainingItemCount: null,
      text: 'pods table',
    }
  }

  override async getPod(name: string): Promise<KubernetesObject> {
    return { object: { kind: 'Pod', metadata: { name } }, text: 'pod object' }
  }

  override async getPodLogs(): Promise<string> {
    return 'log line'
  }

  override async listEvents(): Promise<KubernetesListResult> {
    return { items: [], continue: null, remainingItemCount: null, text: 'events table' }
  }

  override async getResource(_apiVersion: string, kind: string, name: string): Promise<KubernetesObject> {
    return { object: { kind, metadata: { name } }, text: 'object' }
  }

  override async listResources(): Promise<KubernetesListResult> {
    return { items: [], continue: null, remainingItemCount: null, text: 'rows table' }
  }

  override async listNamespaces(): Promise<KubernetesListResult> {
    return { items: [{ Name: 'novo-one', Status: 'Active' }], continue: null, remainingItemCount: null, text: 'namespaces table' }
  }

  override async topPods(): Promise<KubernetesListResult> {
    return { items: [], continue: null, remainingItemCount: null, text: 'pods top table' }
  }

  override async topNodes(): Promise<KubernetesListResult> {
    return { items: [], continue: null, remainingItemCount: null, text: 'nodes top table' }
  }

  override async getNodeLogs(): Promise<string> {
    return 'node log line'
  }

  override async getNodeStatsSummary(name: string): Promise<KubernetesObject> {
    return { object: { node: { nodeName: name }, pods: [] }, text: 'summary' }
  }
}

describe('KubernetesStore Definition', () => {
  it('registers a replaceable implementation at ctx.kubernetesStore', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeKubernetesStore)

    expect(ctx.kubernetesStore).toBeInstanceOf(KubernetesStore)
    expect(ctx.kubernetesStore.backendRef).toBe('fake:kubernetes')
    expect(ctx.kubernetesStore.configured).toBe(true)
    expect(ctx.kubernetesStore.context).toBe('fake-context')
    expect(ctx.kubernetesStore.namespace).toBe('novo-one')
    await expect(ctx.kubernetesStore.listPods({ namespace: 'kube-system' })).resolves.toMatchObject({
      items: [{ Name: 'pod-1', Namespace: 'kube-system' }],
      continue: null,
    })
    await expect(ctx.kubernetesStore.getPod('pod-1')).resolves.toMatchObject({ object: { kind: 'Pod' } })
    await expect(ctx.kubernetesStore.getPodLogs('pod-1')).resolves.toBe('log line')

    await ctx.fiber.dispose()
  })

  it('threads the continuation token through list pages', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeKubernetesStore)

    const first = await ctx.kubernetesStore.listPods({})
    expect(first.continue).toBe(null)
    const second = await ctx.kubernetesStore.listPods({ continue: 'tok-1' })
    expect(second.continue).toBe('next-tok')

    await ctx.fiber.dispose()
  })
})
