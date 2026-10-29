/**
 * Client data layer for the 环境与凭据 settings page — pure and testable.
 *
 * Composition rule: the embedded matrix snapshot (generated from the same
 * `envs.yml` that ships inside `@dsh-sentry/env-matrix`) supplies the shape
 * (which envs exist, which refs each leg wires); the host
 * `remote.credentials.describe` results supply the machine-local facts (which
 * refs currently resolve). Never the values themselves.
 */

import {
  CODE_BASE_REF,
  PLATFORM_CREDENTIAL_REFS,
  aliasesForEnv,
  legCredentialRefs,
  legReadiness,
} from '@dsh-sentry/env-matrix/pure'
import type { LegReadiness, Matrix } from '@dsh-sentry/env-matrix/pure'
import type { CredentialInfo, DefaultEnvInfo, GlobalConfigInfo } from './types.ts'

/** describe() 批量上限（宿主 CredentialsController 的 MAX_DESCRIBE_REFS）。 */
export const DESCRIBE_CHUNK = 64

export type CredentialStatusMap = Record<string, CredentialInfo | undefined>

export interface EnvReadinessView {
  /** canonical environment name (matrix key). */
  env: string
  /** human label from envs.yml (`envLabel`). */
  label: string
  aliases: string[]
  legs: LegReadiness[]
  /** every leg ok — a missing leg simply has no entry and never degrades the env. */
  ready: boolean
  /** union of missing refs across legs. */
  missingRefs: string[]
}

/** 默认环境视图：展示宿主解析结果；本机偏好可通过设置页编辑。 */
export interface DefaultEnvView {
  /** 本机保存的 canonical 环境名；失效值原样返回，未设置时缺省。 */
  preference: string | undefined
  /** 下一个新 Session 实际生效的环境。 */
  effectiveEnv: string | undefined
  /** 装配文件声明的环境；本机偏好未设置或失效时作为新 Session 默认环境。 */
  assemblyEnv: string | undefined
  /** 实际生效值来自本机偏好还是装配环境。 */
  source: 'preference' | 'assembly' | undefined
}

export interface EnvConfigField {
  key: string
  label: string
  value: string
}

/** 全局配置/凭据行：不随环境变化；secret 只投影状态，不投影值。 */
export interface GlobalCredentialView {
  ref: string
  label: string
  description: string
  /** 非机密值（当前仅代码检索根目录）；secret 恒为 undefined。 */
  value: string | undefined
  info: CredentialInfo | undefined
}

const CONFIG_FIELD_LABELS: Record<string, string> = {
  endpoint: '服务地址',
  database: '数据库',
  datasourceUid: '数据源 UID',
  greptimedbJaegerDatasourceUid: 'Jaeger 数据源 UID',
  alertmanagerDatasourceUid: 'Alertmanager 数据源 UID',
  project: '项目',
  envName: '环境名称',
  baseDir: '代码根目录',
}

/** 环境详情中的非机密配置；*Ref 只代表凭据键名，由凭据状态区单独展示。 */
export function configFields(config: object): EnvConfigField[] {
  return Object.entries(config)
    .filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && entry[1] !== '' && !entry[0].endsWith('Ref')
    ))
    .map(([key, value]) => ({ key, label: CONFIG_FIELD_LABELS[key] ?? key, value }))
}

function hasValue(status: CredentialStatusMap): (ref: string) => boolean {
  return ref => status[ref]?.configured === true
}

/** 环境列表：一个环境一行，逐腿 ok/missing；与 use-env --list 同一推导（legReadiness）。 */
export function envReadinessViews(matrix: Matrix, status: CredentialStatusMap): EnvReadinessView[] {
  const configured = hasValue(status)
  return Object.entries(matrix).map(([env, row]) => {
    const legs = legReadiness(row, configured)
    const missingRefs = [...new Set(legs.flatMap(leg => leg.missingRefs))]
    return {
      env,
      label: row.envLabel,
      aliases: aliasesForEnv(env),
      legs,
      ready: legs.every(leg => leg.ok),
      missingRefs,
    }
  })
}

/** describe 分批：保持请求顺序，每段不超过宿主 MAX_DESCRIBE_REFS。 */
export function chunkRefs(refs: string[]): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < refs.length; index += DESCRIBE_CHUNK) {
    chunks.push(refs.slice(index, index + DESCRIBE_CHUNK))
  }
  return chunks
}

/** 页面需要的 ref：环境腿键 + 平台级全局键的并集，排序去重。 */
export function catalogRefs(matrix: Matrix): string[] {
  const refs = new Set<string>(PLATFORM_CREDENTIAL_REFS.map(entry => entry.ref))
  for (const row of Object.values(matrix)) {
    for (const { refs: legRefs } of legCredentialRefs(row)) {
      for (const ref of legRefs) refs.add(ref)
    }
  }
  return [...refs].sort()
}

const GLOBAL_LABELS: Record<string, string> = {
  ZADIG_API_TOKEN: 'Zadig OpenAPI Token',
  TAPD_TOKEN: 'TAPD 访问令牌',
  DSH_SENTRY_CODE_BASE: '代码检索根目录',
}

/**
 * 全局配置视图：平台级键（TAPD / 代码根目录）+ 被所有环境共用的腿键
 * （如 ZADIG_API_TOKEN）。代码根目录是非机密路径，由宿主 GlobalConfig
 * 提供实际值；其余 token 只展示配置状态。
 */
export function globalCredentialViews(
  matrix: Matrix,
  status: CredentialStatusMap,
  globalConfig?: GlobalConfigInfo,
): GlobalCredentialView[] {
  const envCount = Object.keys(matrix).length
  const usage = new Map<string, number>()
  for (const row of Object.values(matrix)) {
    for (const { refs: legRefs } of legCredentialRefs(row)) {
      for (const ref of legRefs) usage.set(ref, (usage.get(ref) ?? 0) + 1)
    }
  }
  const platformRefs = new Set(PLATFORM_CREDENTIAL_REFS.map(entry => entry.ref))
  const rows: GlobalCredentialView[] = []
  const push = (ref: string, description: string): void => {
    rows.push({
      ref,
      label: GLOBAL_LABELS[ref] ?? ref,
      description,
      value: ref === CODE_BASE_REF ? globalConfig?.codeBaseDir : undefined,
      info: status[ref],
    })
  }
  for (const [ref, count] of usage) {
    if (count === envCount && !platformRefs.has(ref)) push(ref, '所有环境共用同一键')
  }
  for (const entry of PLATFORM_CREDENTIAL_REFS) {
    push(entry.ref, entry.ref === CODE_BASE_REF ? '本机路径，不随环境变化；未配置时代码检索腿不启用' : '平台级凭据，不随环境变化')
  }
  return rows
}

/** 默认环境视图。宿主已完成本机偏好与装配环境的优先级解析。 */
export function defaultEnvView(info?: DefaultEnvInfo): DefaultEnvView {
  const source = info === undefined
    ? undefined
    : info.preference !== undefined && info.preference === info.effectiveEnv
      ? 'preference'
      : 'assembly'
  return {
    preference: info?.preference,
    effectiveEnv: info?.effectiveEnv,
    assemblyEnv: info?.assemblyEnv,
    source,
  }
}
