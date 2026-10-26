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
 * - dry-run returns an evidence envelope (original printed raw JSON), and
 *   since the seam migration it carries the backend-neutral request
 *   (mode/service/workflow + backend_ref) — the OpenAPI URL, method and
 *   query params are Provider internals and no longer cross the seam;
 * - evidence refs change shape with the seam migration: the previous
 *   `zadig-inspector: <endpoint-built URL>` forms (pipelines/workloads
 *   routes, plus the bare-endpoint dry-run ref) become
 *   `<backendRef>` + `env:<label>:zadig`, matching the other evidence
 *   legs; list/detail/workflow evidence data gains `backend_ref`;
 * - HTTP and network errors are uniformly `请求 Zadig API 失败: ...` in the
 *   service layer, matching the original's except-branch wording.
 *
 * @module @dsh-sentry/tool-zadig-inspector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import { liveAssemblyEnv } from '@dsh-sentry/env-matrix'
import { parseImageTag, type ZadigServiceRow, type ZadigWorkflowTask } from '@dsh-sentry/service-zadig'
import type {} from '@dsh-sentry/service-zadig'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-zadig-inspector'

/** The seams this plugin registers into. */
export const inject = ['tools', 'zadig']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
})

const SOURCE = 'zadig-inspector'
const TYPE = 'cicd'

/**
 * The Provider identity one execution snapshots at its start: every
 * evidence branch of that call (success, error, dry-run) reports the same
 * backend, even if the assembly swaps the service mid-call.
 */
interface ZadigIdentity {
  project: string
  envName: string
  backendRef: string
}

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

/** Static demo rows for the workflow-history mode (mirrors the live compressed shape). */
export function demoWorkflowTasks(workflow: string): ZadigWorkflowTask[] {
  return [
    {
      task_id: 4776,
      task_creator: '张亮-6845',
      workflow_name: workflow,
      workflow_display_name: '构建部署',
      status: 'passed',
      reverted: false,
      create_time: 1788334627,
      create_time_iso: '2026-09-02T07:37:07Z',
      start_time: 1788334632,
      start_time_iso: '2026-09-02T07:37:12Z',
      stages: [
        {
          name: '构建',
          status: 'passed',
          error: '',
          jobs: [
            {
              name: '构建',
              type: 'zadig-build',
              status: 'passed',
              error: '',
              service_modules: ['novo-one/platform', 'novo-one/infrastructure'],
              code_infos: [
                {
                  repo_name: 'novo-platform-backend',
                  branch: '263.0.2.1/build/build_dev',
                  commit_id: 'c5d3ce6d5680b373a5586676a69342c86c86b67e',
                  commit_title: "Merge branch '263.0.2.1/fix/zl' into '263.0.2.1/build/build_dev'",
                  author_name: '张亮',
                },
              ],
            },
          ],
        },
        {
          name: '部署',
          status: 'passed',
          error: '',
          jobs: [
            {
              name: '部署-研发环境平台托管0',
              type: 'zadig-deploy',
              status: 'passed',
              error: '',
              deploy_env_name: 'dev-platform-hosted-0',
              deploy_env_alias: '研发-DP0',
              service_modules: ['novo-one/platform', 'novo-one/infrastructure'],
              code_infos: [],
            },
          ],
        },
      ],
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
  // Env label resolves per call from the assembly files: this plugin injects a
  // service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const liveEnv = (): string => liveAssemblyEnv() ?? config.env ?? 'unknown'

  ctx.tools.register(defineTool({
    name: 'sentry_query_zadig',
    description:
      'Inspect Zadig CI/CD. Default (no params): list all workloads of the current environment with running '
      + 'status, image version and readiness. With `service`: fetch its latest deployment (pods, images, build '
      + 'time/branch/version). With `workflow`: list recent runs of that workflow (pipeline history: task id, '
      + 'creator, status, timing, built branch/commit, deploy target environments). Read-only; never triggers '
      + 'builds or rollbacks.',
    parameters: {
      service: { type: 'string', description: 'Service name: fetches its latest deployment detail. Omit to list all services.' },
      workflow: { type: 'string', description: 'Workflow name (e.g. static-code-scanning-and-build-deploy): lists its recent task history. Overrides `service` mode.' },
      project: { type: 'string', description: 'Project override for workflow history; defaults to the assembled project.' },
      pageSize: { type: 'number', default: 20, description: 'Workflow history page size (max 50).' },
      demo: { type: 'boolean', default: false, description: 'Return fixed demo data without connecting to Zadig.' },
      dryRun: { type: 'boolean', default: false, description: 'Only return the constructed request, do not send.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      // One Provider snapshot per call: identity and transport agree even if
      // a hot swap replaces the service mid-execution.
      const zadig = ctx.zadig
      const identity: ZadigIdentity = {
        project: zadig.project,
        envName: zadig.envName,
        backendRef: zadig.backendRef,
      }
      const refs = (): string[] => [identity.backendRef, `env:${liveEnv()}:zadig`]

      const service = args.service
      const workflow = args.workflow
      const isWorkflow = workflow !== undefined && workflow.length > 0
      const pageSize = Math.min(Math.max(Number(args.pageSize) || 20, 1), 50)
      const workflowQuery = isWorkflow
        ? {
            workflowName: workflow as string,
            project: typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined,
            pageSize,
          }
        : undefined
      const detailService = workflowQuery === undefined && typeof service === 'string' && service.length > 0
        ? service
        : undefined

      if (args.dryRun === true) {
        // Backend-neutral request only: the OpenAPI URL, method and query
        // params are Provider internals (module doc records the drift).
        const request = workflowQuery !== undefined
          ? {
            mode: 'workflow_tasks' as const,
            workflow: workflowQuery.workflowName,
            ...(workflowQuery.project !== undefined ? { project: workflowQuery.project } : {}),
            page_size: pageSize,
          }
          : detailService !== undefined
            ? { mode: 'service_detail' as const, service: detailService }
            : { mode: 'list_workloads' as const }
        return buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: liveEnv(),
            dry_run: true,
            backend_ref: identity.backendRef,
            request,
          },
          summary: `[dry-run] 构造 Zadig ${workflowQuery !== undefined ? `工作流 ${String(workflow)} 历史` : detailService !== undefined ? `服务 ${detailService} 详情` : '环境服务列表'}查询请求，未发送。`,
          confidence: 1.0,
          refs: refs(),
        }) as unknown as JsonValue
      }

      if (args.demo === true) {
        if (workflowQuery !== undefined) {
          return workflowEvidence(liveEnv(), identity, workflow as string, workflowQuery.project, demoWorkflowTasks(workflow as string), true, undefined)
        }
        if (detailService !== undefined) {
          return detailEvidence(liveEnv(), identity, detailService, demoLatestDeployment(detailService), true, undefined)
        }
        return listEvidence(liveEnv(), identity, demoServices(), true, undefined)
      }

      try {
        if (workflowQuery !== undefined) {
          const tasks = await zadig.fetchWorkflowTasks(workflowQuery)
          return workflowEvidence(liveEnv(), identity, workflow as string, workflowQuery.project, tasks, false, undefined)
        }
        if (detailService !== undefined) {
          const deployment = await zadig.fetchServiceDetail(detailService)
          return detailEvidence(liveEnv(), identity, detailService, deployment, false, undefined)
        }
        const services = await zadig.fetchServices()
        return listEvidence(liveEnv(), identity, services, false, undefined)
      } catch (error) {
        const message = errorMessage(error)
        if (workflowQuery !== undefined) {
          return workflowEvidence(liveEnv(), identity, workflow as string, workflowQuery.project, [], false, message)
        }
        if (detailService !== undefined) {
          return detailEvidence(liveEnv(), identity, detailService, {}, false, message)
        }
        return listEvidence(liveEnv(), identity, [], false, message)
      }
    },
  }))

  /** Workflow-history evidence envelope. */
  function workflowEvidence(
    env: string,
    identity: ZadigIdentity,
    workflow: string,
    projectOverride: string | undefined,
    tasks: ZadigWorkflowTask[],
    demo: boolean,
    error: string | undefined,
  ): JsonValue {
    const project = projectOverride ?? identity.project
    let summary: string
    let confidence: number
    if (error !== undefined) {
      summary = `工作流 ${workflow} 历史查询失败: ${error}`
      confidence = 0.0
    } else {
      const latest = tasks[0]
      summary = `工作流 ${workflow} 最近 ${tasks.length} 次任务`
      if (latest !== undefined) {
        summary += `，最新 #${String(latest.task_id)}(${String(latest.status)})`
          + ` 由 ${String(latest.task_creator)} 发起于 ${latest.create_time_iso ?? '未知时间'}`
      }
      confidence = demo ? 0.5 : 0.95
    }

    return buildEvidence({
      source: SOURCE,
      type: TYPE,
      data: {
        env,
        backend_ref: identity.backendRef,
        project,
        workflow,
        task_count: tasks.length,
        tasks,
        demo,
        error: error ?? null,
      },
      summary,
      confidence,
      refs: [identity.backendRef, `env:${env}:zadig`],
    }) as unknown as JsonValue
  }

  /** Port of `_build_list_evidence`. */
  function listEvidence(
    env: string,
    identity: ZadigIdentity,
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
      summary = `环境 ${env} (${identity.envName}) 共 ${services.length} 个服务`
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
        backend_ref: identity.backendRef,
        project: identity.project,
        env_name: identity.envName,
        service_count: services.length,
        services,
        demo,
        error: error ?? null,
      },
      summary,
      confidence,
      refs: [identity.backendRef, `env:${env}:zadig`],
    }) as unknown as JsonValue
  }

  /** Port of `_build_detail_evidence`. */
  function detailEvidence(
    env: string,
    identity: ZadigIdentity,
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
        backend_ref: identity.backendRef,
        project: identity.project,
        env_name: identity.envName,
        service,
        latest_deployment: deployment,
        demo,
        error: error ?? null,
      },
      summary,
      confidence,
      refs: [identity.backendRef, `env:${env}:zadig`],
    }) as unknown as JsonValue
  }
}
