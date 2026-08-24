/**
 * Methodology skills for the sentry plugins.
 *
 * Ports the original project's instruction layer — one skill per original
 * `skills/<name>/` directory, merging its `SKILL.md`, `prompts/usage.md`
 * and (when present) `methodology.md` into a single model-loadable body.
 * The content is adapted, not copied verbatim:
 * - Claude-Code frontmatter and `python3` CLI examples are gone; the bodies
 *   describe the DSH tools (`sentry_query_logs` etc.) instead;
 * - `--env` disappeared as a parameter — the environment is fixed by the
 *   deployment composition and survives only as evidence metadata;
 * - comma-separated CLI strings became JSON arrays in the parameter tables;
 * - documented drift between the original SKILL.md and the scripts (e.g. the
 *   SQL clause order) is fixed in favor of the actual tool behavior.
 *
 * Skill bodies live in `./skills/*.md` and are read from disk at apply time,
 * so editing them needs no code change (a plugin reload re-reads them).
 *
 * @module @dsh-sentry/sentry-skills
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sentry-skills'

/** The seams this plugin registers into. */
export const inject = ['skills']

/** One bundled skill body. */
interface SkillSpec {
  /** File under `./skills/`. */
  file: string
  /** Registered skill name (kept identical to the original skill names). */
  name: string
  /** One-line description shown in the skill list. */
  description: string
}

/**
 * Skills whose backing tools are ported. mq-inspector and code-repository
 * join this list when their tools land.
 */
const SKILLS: SkillSpec[] = [
  {
    file: 'log-analyzer.md',
    name: 'log-analyzer',
    description:
      '根据服务、时间范围、关键词和过滤条件从 GreptimeDB 查询 k8s 容器日志，提取异常模式（sentry_query_logs / sentry_list_log_services）。',
  },
  {
    file: 'trace-analyzer.md',
    name: 'trace-analyzer',
    description:
      '按 traceId 查询 Grafana Jaeger 调用链路，识别慢调用、错误调用和跨服务边界异常（sentry_fetch_trace）。',
  },
  {
    file: 'metrics-inspector.md',
    name: 'metrics-inspector',
    description:
      '查询 Prometheus 指标曲线与 firing 告警，识别异常拐点（sentry_query_metrics / sentry_list_alerts）。',
  },
  {
    file: 'db-inspector.md',
    name: 'db-inspector',
    description:
      '通过 dbx 平台对 PostgreSQL 执行只读 SQL，收集慢 SQL、连接数、主从延迟等证据（sentry_query_db）。',
  },
  {
    file: 'redis-inspector.md',
    name: 'redis-inspector',
    description:
      '通过 dbx 平台查询 Redis key 的值、TTL 与类型，base64 解码后返回（sentry_query_redis）。',
  },
  {
    file: 'code-repository.md',
    name: 'code-repository',
    description:
      '跨仓代码检索与读取：sentry_search_code（codegraph 索引优先、ripgrep 回退）+ sentry_read_code。从错误信息/日志行/慢 SQL 定位到代码行，作为交叉验证的 code 证据。',
  },
  {
    file: 'defect-troubleshooting.md',
    name: 'defect-troubleshooting',
    description:
      '缺陷排查主方法论：10 步分析框架（描述/事实/未知/假设/验证/排序/信息/修复/回归/复盘）、红线与输出示例。任何「现象明确但根因不清」的排查都应加载。',
  },
  {
    file: 'cross-service-latency.md',
    name: 'cross-service-latency',
    description:
      '跨服务延迟排查专项：p99 升高/接口慢/超时增多的排查步骤、典型根因与止损建议。',
  },
  {
    file: 'incident-templates.md',
    name: 'incident-templates',
    description:
      '结构化输出模板：triage-intake 输入评估、diagnosis-report 诊断报告、action-plan 行动计划、incident-summary 事件摘要、chat-response 对话回复。',
  },
  {
    file: 'project-context.md',
    name: 'project-context',
    description:
      'novo-commctl 项目背景：服务清单、关键用户旅程、常见故障模式、部署拓扑与域名结构、排查边界与升级路径。排查前加载以理解影响面。',
  },
  {
    file: 'zadig-inspector.md',
    name: 'zadig-inspector',
    description:
      '查询 Zadig 环境各服务运行状态、镜像版本与最近一次部署详情，判断故障是否由发布引入（sentry_query_zadig）。',
  },
]

/** Read one bundled skill body. */
function loadSkillContent(file: string): string {
  return readFileSync(new URL(`./skills/${file}`, import.meta.url), 'utf8')
}

/** Register every bundled skill. */
export function apply(ctx: Context): void {
  for (const spec of SKILLS) {
    ctx.skills.register({
      name: spec.name,
      description: spec.description,
      source: 'bundled',
      content: loadSkillContent(spec.file),
    })
  }
}
