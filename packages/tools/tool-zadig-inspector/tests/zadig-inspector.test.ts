import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ZadigService, {
  type WorkflowTasksQuery,
  type ZadigServiceRow,
  type ZadigWorkflowTask,
} from '@dsh-sentry/service-zadig'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as zadigInspector from '../src/index.ts'

/**
 * Fake-Provider contract test: the tool must talk to the `ctx.zadig` slot
 * only, through backend-neutral intents, and stamp every evidence branch
 * (success / error / dry-run) with the Provider's own backend identity —
 * never with endpoint-built URLs it assembles itself.
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

/**
 * Session Provider router stub: leases whatever service this test context
 * mounted globally under a fixed env label. The Session routing itself is
 * covered by tests/session-env.test.ts against the real stack.
 */
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

const FAKE_BACKEND_REF = 'fake:zadig/https://zadig.example.com'

class FakeZadigService extends ZadigService {
  lists = 0
  details: string[] = []
  workflows: WorkflowTasksQuery[] = []
  error?: Error

  override get backendRef(): string {
    return FAKE_BACKEND_REF
  }

  override async fetchServices(): Promise<ZadigServiceRow[]> {
    this.lists++
    if (this.error) throw this.error
    return [
      {
        name: 'order-service',
        status: 'Running',
        ready: 'ready',
        error: '',
        workLoadType: 'Deployment',
        image: null,
        pipeline_url: 'https://zadig.example.com/v1/projects/detail/novo-one/envs/detail/order-service',
      },
    ]
  }

  override async fetchServiceDetail(service: string): Promise<Record<string, unknown>> {
    this.details.push(service)
    if (this.error) throw this.error
    return { service_name: service, status: 'Running' }
  }

  override async fetchWorkflowTasks(query: WorkflowTasksQuery): Promise<ZadigWorkflowTask[]> {
    this.workflows.push(query)
    if (this.error) throw this.error
    return []
  }
}

interface Envelope {
  evidence: {
    data: Record<string, unknown>
    refs?: string[]
    confidence: number
  }
}

let ctx: Context
let service: FakeZadigService

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeZadigService, {
    endpoint: 'https://zadig.example.com',
    project: 'novo-one',
    envName: 'dev-env',
  })
  service = ctx.zadig as FakeZadigService
  await ctx.plugin(StubEnvProviders, { env: 'test' })
  await ctx.plugin(zadigInspector)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_query_zadig') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-zadig-inspector ZadigService Consumer', () => {
  it('lists through the seam and stamps the Provider identity', async () => {
    const output = await tool('sentry_query_zadig').execute({}, {} as never) as Envelope

    expect(service.lists).toBe(1)
    expect(output.evidence.data).toMatchObject({
      env: 'test',
      backend_ref: FAKE_BACKEND_REF,
      project: 'novo-one',
      env_name: 'dev-env',
      service_count: 1,
    })
    expect(output.evidence.refs).toEqual([FAKE_BACKEND_REF, 'env:test:zadig'])
  })

  it('routes service mode to the detail seam', async () => {
    const output = await tool('sentry_query_zadig').execute({ service: 'order-service' }, {} as never) as Envelope

    expect(service.details).toEqual(['order-service'])
    expect(output.evidence.data).toMatchObject({
      backend_ref: FAKE_BACKEND_REF,
      service: 'order-service',
      latest_deployment: { service_name: 'order-service' },
    })
  })

  it('routes workflow mode with normalized pageSize and project override', async () => {
    const output = await tool('sentry_query_zadig').execute({
      workflow: 'static-code-scanning-and-build-deploy',
      project: 'other-project',
      pageSize: 999,
    }, {} as never) as Envelope

    expect(service.workflows).toEqual([{
      workflowName: 'static-code-scanning-and-build-deploy',
      project: 'other-project',
      pageSize: 50,
    }])
    expect(output.evidence.data).toMatchObject({
      backend_ref: FAKE_BACKEND_REF,
      project: 'other-project',
      workflow: 'static-code-scanning-and-build-deploy',
    })
  })

  it('dry-run returns the neutral request without touching the seam', async () => {
    const output = await tool('sentry_query_zadig').execute({ dryRun: true }, {} as never) as Envelope

    expect(service.lists).toBe(0)
    expect(service.details).toEqual([])
    expect(service.workflows).toEqual([])
    expect(output.evidence.data).toMatchObject({
      dry_run: true,
      backend_ref: FAKE_BACKEND_REF,
      request: { mode: 'list_workloads' },
    })
    expect(output.evidence.data).not.toHaveProperty('url')
    expect(output.evidence.data).not.toHaveProperty('method')
    expect(output.evidence.data).not.toHaveProperty('params')
    expect(output.evidence.refs).toEqual([FAKE_BACKEND_REF, 'env:test:zadig'])
  })

  it('dry-run describes the workflow intent neutrally', async () => {
    const output = await tool('sentry_query_zadig').execute({
      workflow: 'wf-x',
      dryRun: true,
    }, {} as never) as Envelope

    expect(output.evidence.data.request).toEqual({
      mode: 'workflow_tasks',
      workflow: 'wf-x',
      page_size: 20,
    })
  })

  it('keeps Provider failures inside the existing evidence envelope', async () => {
    service.error = new Error('请求 Zadig API 失败: Zadig HTTP 500: boom')
    const output = await tool('sentry_query_zadig').execute({}, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: '请求 Zadig API 失败: Zadig HTTP 500: boom' })
    expect(output.evidence.refs).toEqual([FAKE_BACKEND_REF, 'env:test:zadig'])
  })

  it('demo mode answers without the seam', async () => {
    const output = await tool('sentry_query_zadig').execute({ demo: true }, {} as never) as Envelope

    expect(service.lists).toBe(0)
    expect(output.evidence.data).toMatchObject({ demo: true, env: 'test' })
  })
})
