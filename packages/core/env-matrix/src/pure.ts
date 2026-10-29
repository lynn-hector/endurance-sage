/**
 * Pure environment-matrix vocabulary: zero Node imports, browser-bundleable.
 *
 * The web settings page (`@dsh-sentry/ui-settings`) inlines this module into
 * its client bundle so the browser computes the same per-leg readiness the
 * CLI and the env-switcher tool derive host-side. Anything that touches the
 * filesystem or `process` stays in the package root (`./index.ts`); adding a
 * Node import here re-breaks client bundling.
 *
 * @module @dsh-sentry/env-matrix/pure
 */

export interface EnvLeg {
  endpoint?: string
  database?: string
  /** Prometheus 数据源 uid（仅 prometheus 腿使用） */
  datasourceUid?: string
  /** Grafana 内 GreptimeDB-Jaeger 数据源的 uid（仅 grafana 腿使用，uid 随环境漂移） */
  greptimedbJaegerDatasourceUid?: string
  /** Grafana 内 Alertmanager 数据源的 uid（仅 grafana 腿派生服务使用，缺省 alertmanager） */
  alertmanagerDatasourceUid?: string
  project?: string
  envName?: string
  usernameRef?: string
  passwordRef?: string
  /** 腿特定 token 引用，语义随腿变化：prometheus 腿=Bearer token；greptimedb 腿=dashboard connect token（解密还原账密，见 docs/guides/credentials.md）；kubernetes 腿=MCP 网关 Bearer token（网关启用鉴权后配置） */
  tokenRef?: string
  /** kubernetes 腿的 kubeconfig context 名（Rancher 多集群选择，随环境行配置，与环境名基本 1:1） */
  context?: string
}

export interface EnvRow {
  envLabel: string
  greptimedb: EnvLeg
  grafana: EnvLeg
  prometheus: EnvLeg
  dbx: EnvLeg
  rocketmq: EnvLeg
  zadig: EnvLeg
  db?: { database?: string }
  codeRepository?: { baseDir?: string }
  /**
   * kubernetes 视图腿（可选）：经平台级 kubernetes-mcp-server 网关只读访问
   * 该环境对应的集群。省略整块时该腿不渲染、不参与就绪推导——旧矩阵无需迁移。
   */
  kubernetes?: EnvLeg
}

export interface Matrix {
  [env: string]: EnvRow
}

export const ENV_ALIASES: Readonly<Record<string, string>> = {
  DP0: 'dev-platform-hosted-0',
  DP1: 'dev-platform-hosted-1',
  DC0: 'dev-client-hosted-0',
  TP0: 'tst-platform-hosted-0',
  TP1: 'tst-platform-hosted-1',
  TC0: 'tst-client-hosted-0',
  SC1: 'sit-client-hosted-1',
  SC2: 'sit-client-hosted-2',
  PBO: 'pro-br-saas-aws-eks-novo',
  TPSG0: 'tst-platform-aws-eks-sg-0',
  PUO: 'pro-use-saas-aws-eks-novo',
  PZO: 'pro-za-saas-aws-eks-novo',
  PDO: 'pro-de-saas-aws-eks-novo',
  PSO: 'pro-sg-saas-aws-eks-novo',
  TPDE0: 'tst-platform-aws-eks-de-0',
  TPUS0: 'tst-platform-aws-eks-us-0',
  TPAU0: 'tst-platform-aws-eks-au-0',
}

export interface LegReadiness {
  leg: 'greptimedb' | 'grafana' | 'prometheus' | 'dbx' | 'rocketmq' | 'zadig' | 'kubernetes'
  ok: boolean
  /** greptimedb 腿的认证模式，与渲染接线一致：tokenRef 定义即 token，否则账密 */
  authMode?: 'token' | 'basic'
  missingRefs: string[]
}

/** tapd 是平台级数据源，凭据键不随环境分段；renderEntries 的装配与此处共用一个常量。 */
export const TAPD_TOKEN_REF = 'TAPD_TOKEN'

/**
 * 默认环境偏好键（机器本地、非机密）：值为 canonical 环境名或短名。写入本机
 * 凭据库（"一台机器只配一个文件"，与 CODE_BASE_REF 同一先例）；宿主
 * `env-binding` 解析默认环境时以 凭据库/环境变量 > 装配环境的顺序取值，
 * 未设置或失效（矩阵漂移）时使用装配环境。Web 设置页通过只读卡片展示解析
 * 结果，不提供编辑入口。
 */
export const DEFAULT_ENV_REF = 'DSH_SENTRY_DEFAULT_ENV'

/** 代码检索腿的机器本地检出根目录键（值是路径不是机密，寄存在凭据库仅为"一机一文件"）。 */
export const CODE_BASE_REF = 'DSH_SENTRY_CODE_BASE'

/**
 * 平台级凭据引用：不属于任何环境腿、跨环境共享的键。GUI 凭据页把它们与
 * 环境腿键区分展示；环境就绪矩阵不评估它们。
 */
export interface PlatformCredentialRef {
  ref: string
  system: string
  /** 界面说明：这个键从哪里获取。 */
  hint: string
}

export const PLATFORM_CREDENTIAL_REFS: readonly PlatformCredentialRef[] = [
  { ref: TAPD_TOKEN_REF, system: 'tapd', hint: 'TAPD 网页 → 我的设置 → 个人访问令牌' },
  { ref: CODE_BASE_REF, system: 'code-repository', hint: '本机业务代码检出根目录（路径，非机密）；留空时代码检索腿不启用' },
] as const

export function resolveEnvName(input: string, matrix: Matrix): string | undefined {
  if (Object.hasOwn(matrix, input)) return input
  const canonical = ENV_ALIASES[input.toUpperCase()]
  return canonical !== undefined && Object.hasOwn(matrix, canonical) ? canonical : undefined
}

export function aliasesForEnv(name: string): string[] {
  return Object.entries(ENV_ALIASES)
    .filter(([, canonical]) => canonical === name)
    .map(([alias]) => alias)
}

/**
 * All credential refs a row declares — a config-shape contract (envs.yml rows
 * must name every ref they wire; greptimedb dual-config lists both sets).
 * Value-aware runtime readiness (missing/empty degrades the leg, never blocks
 * a switch) lives in {@link legReadiness}.
 */
export function requiredCredentialRefs(row: EnvRow): string[] {
  return [
    row.greptimedb.usernameRef,
    row.greptimedb.passwordRef,
    row.greptimedb.tokenRef,
    row.grafana.usernameRef,
    row.grafana.passwordRef,
    row.dbx.passwordRef,
    row.rocketmq.usernameRef,
    row.rocketmq.passwordRef,
    row.zadig.tokenRef,
    row.prometheus.tokenRef,
    row.kubernetes?.tokenRef,
  ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
}

/**
 * Per-leg credential readiness over a value predicate: `hasValue(ref)` answers
 * whether that reference currently resolves to a non-empty value. Host-side
 * callers wrap `credentialValues` (credential store + process env); the web
 * settings page wraps `remote.credentials.describe` results — one derivation,
 * two sources, no drift. Only legs that configure refs are evaluated.
 * greptimedb is either/or: with `tokenRef` defined the leg evaluates token mode
 * only (leftover basic refs are ignored, mirroring renderEntries'
 * connectTokenRef-first wiring). A degraded `grafana` leg is wider than its
 * name: trace / prometheus (form login) / alertmanager tools share the grafana
 * credentials and degrade with it.
 */
export function legReadiness(row: EnvRow, hasValue: (ref: string) => boolean): LegReadiness[] {
  const evaluate = (
    leg: LegReadiness['leg'],
    refs: Array<string | undefined>,
    authMode?: LegReadiness['authMode'],
  ): LegReadiness => {
    const missingRefs = refs
      .filter((ref): ref is string => ref !== undefined)
      .filter(ref => !hasValue(ref))
    return {
      leg,
      ok: missingRefs.length === 0,
      ...(authMode !== undefined ? { authMode } : {}),
      missingRefs,
    }
  }
  const legs: LegReadiness[] = []
  const greptimedbToken = row.greptimedb.tokenRef !== undefined
  const greptimedbHasRefs = greptimedbToken
    || row.greptimedb.usernameRef !== undefined
    || row.greptimedb.passwordRef !== undefined
  if (greptimedbHasRefs) {
    legs.push(evaluate(
      'greptimedb',
      greptimedbToken ? [row.greptimedb.tokenRef] : [row.greptimedb.usernameRef, row.greptimedb.passwordRef],
      greptimedbToken ? 'token' : 'basic',
    ))
  }
  if (row.grafana.usernameRef !== undefined || row.grafana.passwordRef !== undefined) {
    legs.push(evaluate('grafana', [row.grafana.usernameRef, row.grafana.passwordRef]))
  }
  // prometheus 统一走 grafana 表单登录；tokenRef 是单环境 Bearer 逃生口
  if (row.prometheus.tokenRef !== undefined) {
    legs.push(evaluate('prometheus', [row.prometheus.tokenRef], 'token'))
  }
  if (row.dbx.passwordRef !== undefined) legs.push(evaluate('dbx', [row.dbx.passwordRef]))
  if (row.rocketmq.usernameRef !== undefined || row.rocketmq.passwordRef !== undefined) {
    legs.push(evaluate('rocketmq', [row.rocketmq.usernameRef, row.rocketmq.passwordRef]))
  }
  if (row.zadig.tokenRef !== undefined) legs.push(evaluate('zadig', [row.zadig.tokenRef]))
  // kubernetes 网关当前免鉴权：无 tokenRef 时不产生独立就绪腿（网关、集群凭据都在
  // 服务端）；网关启用鉴权后配置 tokenRef，本腿自动进入逐环境就绪推导
  if (row.kubernetes?.tokenRef !== undefined) legs.push(evaluate('kubernetes', [row.kubernetes.tokenRef]))
  return legs
}

/**
 * The refs each configured leg wires, regardless of readiness — the shape
 * view behind {@link legReadiness} (same leg set, same greptimedb either/or
 * rule, but every wired ref, not only missing ones). GUI credential catalogs
 * use this to attribute a ref to its legs and environments.
 */
export function legCredentialRefs(row: EnvRow): Array<{ leg: LegReadiness['leg']; refs: string[] }> {
  const legs: Array<{ leg: LegReadiness['leg']; refs: string[] }> = []
  const greptimedbToken = row.greptimedb.tokenRef !== undefined
  const greptimedbHasRefs = greptimedbToken
    || row.greptimedb.usernameRef !== undefined
    || row.greptimedb.passwordRef !== undefined
  if (greptimedbHasRefs) {
    legs.push({
      leg: 'greptimedb',
      refs: greptimedbToken
        ? [row.greptimedb.tokenRef!]
        : [row.greptimedb.usernameRef, row.greptimedb.passwordRef].filter((ref): ref is string => ref !== undefined),
    })
  }
  if (row.grafana.usernameRef !== undefined || row.grafana.passwordRef !== undefined) {
    legs.push({
      leg: 'grafana',
      refs: [row.grafana.usernameRef, row.grafana.passwordRef].filter((ref): ref is string => ref !== undefined),
    })
  }
  if (row.prometheus.tokenRef !== undefined) legs.push({ leg: 'prometheus', refs: [row.prometheus.tokenRef] })
  if (row.dbx.passwordRef !== undefined) legs.push({ leg: 'dbx', refs: [row.dbx.passwordRef] })
  if (row.rocketmq.usernameRef !== undefined || row.rocketmq.passwordRef !== undefined) {
    legs.push({
      leg: 'rocketmq',
      refs: [row.rocketmq.usernameRef, row.rocketmq.passwordRef].filter((ref): ref is string => ref !== undefined),
    })
  }
  if (row.zadig.tokenRef !== undefined) legs.push({ leg: 'zadig', refs: [row.zadig.tokenRef] })
  if (row.kubernetes?.tokenRef !== undefined) legs.push({ leg: 'kubernetes', refs: [row.kubernetes.tokenRef] })
  return legs
}

/**
 * Union of every credential ref the matrix names (all environments' legs plus
 * platform-level refs), deduplicated and sorted — the full catalog a GUI
 * credentials page offers for editing.
 */
export function matrixCredentialRefs(matrix: Matrix): string[] {
  const refs = new Set<string>(PLATFORM_CREDENTIAL_REFS.map(entry => entry.ref))
  for (const row of Object.values(matrix)) {
    for (const ref of requiredCredentialRefs(row)) refs.add(ref)
  }
  return [...refs].sort()
}
