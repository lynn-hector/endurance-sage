/**
 * Zadig inspector tool: list the workloads of a Zadig environment, or fetch
 * one service's latest deployment, in the unified evidence envelope.
 *
 * Port of the original `skills/zadig-inspector` (SKILL.md +
 * scripts/inspect.py). The two CLI modes collapse into one JSON-Schema tool:
 * omitting `service` lists the environment (the `--service`-less path);
 * providing it fetches the deployment detail. `--demo` and `--dry-run` are
 * kept as parameters.
 *
 * The original already printed the standard `{"evidence": ...}` envelope
 * (unlike most sibling scripts), so no envelope normalization was needed.
 *
 * Deliberate deviations:
 * - the demo/dry-run "degraded config" fallback (example.com defaults when
 *   config was incomplete) is gone — the service Config is validated by the
 *   schema at load time;
 * - dry-run returns an evidence envelope (original printed raw JSON);
 * - HTTP and network errors are uniformly `请求 Zadig API 失败: ...` in the
 *   service layer, matching the original's except-branch wording.
 *
 * @module @dsh-sentry/tool-zadig-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import { parseImageTag, type ZadigServiceRow } from '@dsh-sentry/service-zadig'
import type {} from '@dsh-sentry/service-zadig'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-zadig-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'zadig']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Environment label (`local` / `staging` / `production`); evidence metadata only. */
  env: string
}

export const Config: z<Config> = z.object({
  env: z.string().required().description('环境标识（local/staging/production），仅作为 evidence 元数据'),
})

const SOURCE = 'zadig-inspector'
const TYPE = 'cicd'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Port of `_demo_services`: the script's static demo rows. */
export function demoServices(): ZadigServiceRow[] {
  const image = 'hub.yeastardigital.com/novo-one/order-service:20260727155647-3325-263.0.2.1-dev'
  const payment = 'hub.yeastardigital.com/novo-one/payment-service:20260727155647-3325-263.0.2.1-dev'
  return [
    {
      name: 'order-service',
      status: 'Running',
      ready: 'ready',
      error: '',
      workLoadType: 'Deployment',
      ...parseImageTag(image),
      pipeline_url: 'https://zadig.example.com/v1/projects/detail/demo/envs/detail/order-service?envName=demo-env',
    },
    {
      name: 'payment-service',
      status: 'Running',
      ready: 'not ready',
      error: '',
      workLoadType: 'Deployment',
      ...parseImageTag(payment),
      pipeline_url: 'https://zadig.example.com/v1/projects/detail/demo/envs/detail/payment-service?envName=demo-env',
    },
  ]
}

/** Port of `_demo_latest_deployment`: the script's static demo detail. */
export function demoLatestDeployment(service: string): Record<string, unknown> {
  const image = `hub.yeastardigital.com/novo-one/${service}:20260727155647-3325-263.0.2.1-dev`
  return {
    service_name: service,
    namespace: 'novo-one',
    env_name: 'demo-env',
    product_name: 'demo-project',
    ...parseImageTag(image),
    replicas: 1,
    status: 'Running',
    ready: 'ready',
    pods: [
      {
        name: `${service}-6c7679b978-ghj6s`,
        status: 'Running',
        age: '4h',
        ip: '10.0.0.30',
        node_name: 'vm-5-5-ubuntu',
        started_at: 1785139207,
        started_at_iso: '2026-07-27T15:40:07Z',
        containers: [
          {
            name: service,
            image,
            restart_count: 0,
            status: 'running',
            ready: true,
          },
        ],
      },
    ],
  }
}

/** Register the Zadig query tool. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sentry_query_zadig',
    description:
      'Inspect the Zadig CI/CD environment: without `service`, list all workloads with running status, '
      + 'image version and readiness; with `service`, fetch its latest deployment (pods, images, build '
      + 'time/branch/version). Read-only; never triggers builds or rollbacks.',
    parameters: {
      service: { type: 'string', description: 'Service name: fetches its latest deployment detail. Omit to list all services.' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Zadig.' },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const service = args.service
      const isDetail = service !== undefined && service.length > 0

      if (args.dryRun === true) {
        const built = isDetail
          ? ctx.zadig.buildServiceDetailRequest(service)
          : ctx.zadig.buildWorkloadsRequest()
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            dry_run: true,
            method: 'GET',
            url: built.url,
            params: built.params,
          },
          summary: `[dry-run] 构造 Zadig ${isDetail ? `服务 ${service} 详情` : '环境服务列表'}查询请求，未发送。`,
          confidence: 1.0,
          refs: [`zadig-inspector: ${ctx.zadig.endpoint}`],
        }) as unknown as JsonValue
      }

      if (args.demo === true) {
        if (isDetail) {
          return detailEvidence(config.env, ctx, service, demoLatestDeployment(service), true, undefined)
        }
        return listEvidence(config.env, ctx, demoServices(), true, undefined)
      }

      try {
        if (isDetail) {
          const deployment = await ctx.zadig.fetchServiceDetail(service)
          return detailEvidence(config.env, ctx, service, deployment, false, undefined)
        }
        const services = await ctx.zadig.fetchServices()
        return listEvidence(config.env, ctx, services, false, undefined)
      } catch (error) {
        const message = errorMessage(error)
        if (isDetail) {
          return detailEvidence(config.env, ctx, service, {}, false, message)
        }
        return listEvidence(config.env, ctx, [], false, message)
      }
    },
  }))

  /** Port of `_build_list_evidence`. */
  function listEvidence(
    env: string,
    ctx: Context,
    services: ZadigServiceRow[],
    demo: boolean,
    error: string | undefined,
  ): JsonValue {
    let summary: string
    let confidence: number
    if (error !== undefined) {
      summary = `Zadig 查询失败: ${error}`
      confidence = 0.0
    } else {
      const notReady = services.filter(s => s.ready !== 'ready' || s.status !== 'Running')
      summary = `环境 ${env} (${ctx.zadig.envName}) 共 ${services.length} 个服务`
      if (notReady.length > 0) {
        summary += `，其中 ${notReady.length} 个未就绪: ${notReady.map(s => s.name).join(', ')}`
      }
      confidence = demo ? 0.5 : 0.95
    }

    return buildEvidence({
      source: SOURCE,
      type: TYPE,
      data: {
        env,
        project: ctx.zadig.project,
        env_name: ctx.zadig.envName,
        service_count: services.length,
        services,
        demo,
        error: error ?? null,
      },
      summary,
      confidence,
      refs: [`zadig-inspector: ${ctx.zadig.endpoint}/api/aslan/environment/environments/${ctx.zadig.envName}/workloads?projectName=${ctx.zadig.project}`],
    }) as unknown as JsonValue
  }

  /** Port of `_build_detail_evidence`. */
  function detailEvidence(
    env: string,
    ctx: Context,
    service: string,
    deployment: Record<string, unknown>,
    demo: boolean,
    error: string | undefined,
  ): JsonValue {
    let summary: string
    let confidence: number
    if (error !== undefined) {
      summary = `服务 ${service} 的部署详情查询失败: ${error}`
      confidence = 0.0
    } else {
      const status = deployment['status'] ?? 'unknown'
      const version = deployment['version'] as string | undefined
      const branch = deployment['branch'] as string | undefined
      const buildTime = deployment['build_time'] as string | undefined
      summary = `服务 ${service} 最近一次部署状态: ${String(status)}`
      if (version) summary += `，版本: ${version}`
      if (branch) summary += `，分支: ${branch}`
      if (buildTime) summary += `，构建时间: ${buildTime}`
      confidence = demo ? 0.5 : 0.95
    }

    return buildEvidence({
      source: SOURCE,
      type: TYPE,
      data: {
        env,
        project: ctx.zadig.project,
        env_name: ctx.zadig.envName,
        service,
        latest_deployment: deployment,
        demo,
        error: error ?? null,
      },
      summary,
      confidence,
      refs: [`zadig-inspector: project=${ctx.zadig.project}, env_name=${ctx.zadig.envName}, service=${service}`],
    }) as unknown as JsonValue
  }
}
