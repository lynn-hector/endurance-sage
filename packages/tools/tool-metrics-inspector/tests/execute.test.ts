import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AlertmanagerService from '@dsh-sentry/service-alertmanager'
import PrometheusService from '@dsh-sentry/service-prometheus'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as metricsInspector from '../src/index.ts'

/** ToolRuntime inject 的 systemPrompt 缝的最小桩——execute 层测试不需要真实现。 */
class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  /** ToolRuntime 构造期会调用；空清单即可（测试不经过 system prompt 组装路径）。 */
  tools(): unknown[] {
    return []
  }

  async assemble(): Promise<{ sections: unknown[] }> {
    return { sections: [] }
  }
}

/**
 * Execute-level harness: boots the real registration spine (ToolRuntime +
 * prometheus + alertmanager services with example.invalid endpoints) and
 * calls tool execute() directly. Covers behavior that lives in the execute
 * layer (demo shapes, argument validation) the pure-function suites cannot
 * reach; demo/error paths never touch the network.
 */

let ctx: Context

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PrometheusService, { endpoint: 'http://prometheus.example.invalid' })
  await ctx.plugin(AlertmanagerService, { grafanaEndpoint: 'https://grafana.example.invalid' })
  await ctx.plugin(metricsInspector, { env: 'local' })
})

afterAll(async () => {
  await ctx.fiber.dispose()
})

interface Envelope {
  evidence: {
    // biome-ignore lint: 测试侧宽松取值，形状由断言约束
    data: any
    summary: string
    confidence: number
    refs?: string[]
  }
}

async function runTool(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const tool = ctx.tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return (await tool.execute(args, {} as never)) as Envelope
}

describe('sentry_query_metrics demo（execute 层）', () => {
  it('instant（time）模式只产一个数据点——没有 timestamp 缺失的幽灵第二点', async () => {
    const out = await runTool('sentry_query_metrics', { time: '2026-10-01T00:00:00Z', demo: true })
    expect(out.evidence.confidence).toBe(1)
    for (const metric of out.evidence.data.metrics) {
      expect(metric.data_points).toHaveLength(1)
      expect(metric.data_points[0].timestamp).toBe('2026-10-01T00:00:00Z')
    }
  })

  it('instant 模式不回显被忽略的 start/end——证据不声称查过从未查询的区间', async () => {
    const out = await runTool('sentry_query_metrics', {
      time: '2026-10-01T00:00:00Z',
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-02T00:00:00Z',
      demo: true,
    })
    expect(out.evidence.data.mode).toBe('instant')
    expect(out.evidence.data.start).toBeNull()
    expect(out.evidence.data.end).toBeNull()
  })

  it('range 模式保持两点（start/end 各一）', async () => {
    const out = await runTool('sentry_query_metrics', {
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T01:00:00Z',
      demo: true,
    })
    expect(out.evidence.data.metrics[0].data_points).toHaveLength(2)
    expect(out.evidence.data.metrics[0].data_points[1].timestamp).toBe('2026-10-01T01:00:00Z')
  })

  it('非字符串 time 在框架参数校验层被拒（dsh-tools execute 前校验），到不了工具体', async () => {
    await expect(runTool('sentry_query_metrics', {
      time: 1784714400,
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T01:00:00Z',
      demo: true,
    })).rejects.toThrow('must be a string')
  })
})

describe('sentry_list_am_silences state 参数（execute 层）', () => {
  it('非法 state（如 pending）返回 confidence 0 错误证据，不静默丢掉过滤条件', async () => {
    const out = await runTool('sentry_list_am_silences', { state: 'pending', demo: true })
    expect(out.evidence.confidence).toBe(0)
    expect(out.evidence.data.error).toContain('state')
  })

  it('active 与缺省均接受（demo 正常返回静默清单）', async () => {
    const ok = await runTool('sentry_list_am_silences', { state: 'active', demo: true })
    expect(ok.evidence.confidence).toBe(1)
    const all = await runTool('sentry_list_am_silences', { demo: true })
    expect(all.evidence.confidence).toBe(1)
  })
})

describe('AM 证据可溯源性（execute 层）', () => {
  it('sentry_list_am_alerts/silences 的 refs 引用真实数据源（grafana + uid），而非 proxied 下为空的 prometheus endpoint', async () => {
    const alerts = await runTool('sentry_list_am_alerts', { demo: true })
    expect(alerts.evidence.refs).toContain('https://grafana.example.invalid/datasources/uid/alertmanager')
    const silences = await runTool('sentry_list_am_silences', { demo: true })
    expect(silences.evidence.refs).toContain('https://grafana.example.invalid/datasources/uid/alertmanager')
  })
})

describe('半配置宿主的 demo 边界（execute 层）', () => {
  let bareCtx: Context

  beforeAll(async () => {
    bareCtx = new Context()
    await bareCtx.plugin(StubSystemPrompt)
    await bareCtx.plugin(ToolRuntime)
    // direct 模式且 endpoint 为空——半配置宿主；alertmanager 无关本组用例
    await bareCtx.plugin(PrometheusService, {})
    await bareCtx.plugin(AlertmanagerService, { grafanaEndpoint: 'https://grafana.example.invalid' })
    await bareCtx.plugin(metricsInspector, { env: 'local' })
  })

  afterAll(async () => {
    await bareCtx.fiber.dispose()
  })

  it('sentry_get_alert_rule 的 demo 也不越过 endpoint 守卫（与兄弟工具同一顺序：先检查配置）', async () => {
    const tool = bareCtx.tools.get('sentry_get_alert_rule')
    if (tool === undefined) throw new Error('tool not registered')
    const out = (await tool.execute({ name: 'demo-rule', demo: true }, {} as never)) as Envelope
    expect(out.evidence.confidence).toBe(0)
    expect(String(out.evidence.data.error)).toContain('endpoint')
  })
})

describe('proxied 装配的 dry-run（execute 层）', () => {
  let proxiedCtx: Context

  beforeAll(async () => {
    proxiedCtx = new Context()
    await proxiedCtx.plugin(StubSystemPrompt)
    await proxiedCtx.plugin(ToolRuntime)
    await proxiedCtx.plugin(PrometheusService, { grafanaEndpoint: 'https://grafana.example.invalid' })
    await proxiedCtx.plugin(AlertmanagerService, { grafanaEndpoint: 'https://grafana.example.invalid' })
    await proxiedCtx.plugin(metricsInspector, { env: 'local' })
  })

  afterAll(async () => {
    await proxiedCtx.fiber.dispose()
  })

  async function runProxied(name: string, args: Record<string, unknown>): Promise<Envelope> {
    const tool = proxiedCtx.tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return (await tool.execute(args, {} as never)) as Envelope
  }

  it('range dry-run 显示真实请求形状（POST /api/ds/query + body），不再显示从未发送的直连 /api/v1/query_range', async () => {
    const out = await runProxied('sentry_query_metrics', {
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T00:30:00Z',
      dryRun: true,
    })
    const requests = out.evidence.data.requests
    expect(requests.length).toBeGreaterThan(0)
    for (const req of requests) {
      expect(req.url).toBe('https://grafana.example.invalid/api/ds/query')
      expect(req.method).toBe('POST')
      expect(req.body.queries[0].expr).toBeTruthy()
    }
  })

  it('proxied 装配下 prometheus 工具的证据 refs 也引用真实数据源（grafana + uid），不只 env', async () => {
    const out = await runProxied('sentry_query_metrics', {
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-01T00:30:00Z',
      dryRun: true,
    })
    expect(out.evidence.refs).toContain('https://grafana.example.invalid/datasources/uid/prometheus')
  })
})
