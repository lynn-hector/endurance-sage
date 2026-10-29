import { describe, expect, it } from 'vitest'
import { DEFAULT_ENV_REF, ENV_ALIASES } from '@dsh-sentry/env-matrix/pure'
import type { Matrix } from '@dsh-sentry/env-matrix/pure'
import { MATRIX } from '../client/generated-matrix.ts'
import {
  DESCRIBE_CHUNK,
  catalogRefs,
  chunkRefs,
  configFields,
  defaultEnvView,
  envReadinessViews,
  globalCredentialViews,
} from '../client/model.ts'
import type { CredentialStatusMap } from '../client/model.ts'

/** 最小矩阵：一条账密 greptimedb 环境 + 一条 token 模式环境，共用 ZADIG_API_TOKEN。 */
const matrix: Matrix = {
  'dev-platform-hosted-0': {
    envLabel: 'dev-platform-hosted-0',
    greptimedb: {
      endpoint: 'https://greptimedb.dev',
      usernameRef: 'GREPTIMEDB_DP0_USERNAME',
      passwordRef: 'GREPTIMEDB_DP0_PASSWORD',
    },
    grafana: {
      endpoint: 'https://grafana.dev',
      usernameRef: 'GRAFANA_DP0_USERNAME',
      passwordRef: 'GRAFANA_DP0_PASSWORD',
    },
    prometheus: { datasourceUid: 'prometheus' },
    dbx: { endpoint: 'https://dbx.dev', passwordRef: 'DBX_DP0_PASSWORD' },
    rocketmq: {
      endpoint: 'https://rocketmq.dev',
      usernameRef: 'ROCKETMQ_DP0_USERNAME',
      passwordRef: 'ROCKETMQ_DP0_PASSWORD',
    },
    zadig: { endpoint: 'https://zadig.dev', project: 'p', envName: 'dev', tokenRef: 'ZADIG_API_TOKEN' },
  },
  'pro-br-saas-aws-eks-novo': {
    envLabel: 'pro-br-saas-aws-eks-novo',
    greptimedb: {
      endpoint: 'https://greptimedb.pro',
      tokenRef: 'GREPTIMEDB_PBO_CONNECT_TOKEN',
    },
    grafana: {
      endpoint: 'https://grafana.pro',
      usernameRef: 'GRAFANA_PBO_USERNAME',
      passwordRef: 'GRAFANA_PBO_PASSWORD',
    },
    prometheus: { datasourceUid: 'prometheus' },
    dbx: { endpoint: 'https://dbx.pro', passwordRef: 'DBX_PBO_PASSWORD' },
    rocketmq: {
      endpoint: 'https://rocketmq.pro',
      usernameRef: 'ROCKETMQ_PBO_USERNAME',
      passwordRef: 'ROCKETMQ_PBO_PASSWORD',
    },
    zadig: { endpoint: 'https://zadig.pro', project: 'p', envName: 'pro', tokenRef: 'ZADIG_API_TOKEN' },
  },
}

function statusOf(configured: string[]): CredentialStatusMap {
  const status: CredentialStatusMap = {}
  for (const ref of configured) status[ref] = { configured: true, writable: true }
  return status
}

describe('envReadinessViews（就绪矩阵）', () => {
  it('一个环境一行，逐腿 ok/missing，ready 为全腿合取', () => {
    const views = envReadinessViews(matrix, statusOf([
      'GREPTIMEDB_DP0_USERNAME', 'GREPTIMEDB_DP0_PASSWORD', 'GRAFANA_DP0_USERNAME', 'GRAFANA_DP0_PASSWORD',
      'DBX_DP0_PASSWORD', 'ROCKETMQ_DP0_USERNAME', 'ROCKETMQ_DP0_PASSWORD', 'ZADIG_API_TOKEN',
      'GREPTIMEDB_PBO_CONNECT_TOKEN',
    ]))
    expect(views.map(view => view.env)).toEqual(['dev-platform-hosted-0', 'pro-br-saas-aws-eks-novo'])
    const dev = views[0]!
    expect(dev.ready).toBe(true)
    expect(dev.legs.map(leg => leg.leg)).toEqual(['greptimedb', 'grafana', 'dbx', 'rocketmq', 'zadig'])
    // PBO 缺 grafana/dbx/rocketmq 三组键：缺值只降级对应腿
    const pro = views[1]!
    expect(pro.ready).toBe(false)
    expect(pro.legs.filter(leg => leg.ok).map(leg => leg.leg)).toEqual(['greptimedb', 'zadig'])
    expect(pro.missingRefs).toEqual(['GRAFANA_PBO_USERNAME', 'GRAFANA_PBO_PASSWORD', 'DBX_PBO_PASSWORD', 'ROCKETMQ_PBO_USERNAME', 'ROCKETMQ_PBO_PASSWORD'])
  })

  it('greptimedb tokenRef 定义即 token 模式（与 use-env --list 同一推导）', () => {
    const views = envReadinessViews(matrix, statusOf(['GREPTIMEDB_PBO_CONNECT_TOKEN', 'ZADIG_API_TOKEN']))
    const leg = views[1]!.legs.find(item => item.leg === 'greptimedb')
    expect(leg?.authMode).toBe('token')
    expect(leg?.ok).toBe(true)
  })

  it('prometheus 未配 tokenRef 不产生独立腿；别名随行携带', () => {
    const views = envReadinessViews(matrix, statusOf(catalogRefs(matrix)))
    for (const view of views) {
      expect(view.legs.find(leg => leg.leg === 'prometheus')).toBeUndefined()
    }
    expect(views[0]!.aliases).toContain('DP0')
    expect(views[1]!.aliases).toContain('PBO')
  })
})

describe('configFields（环境详情配置）', () => {
  it('展示非机密配置及中文标签，排除空值和凭据引用', () => {
    expect(configFields({
      endpoint: 'https://greptimedb.dev',
      database: 'public',
      usernameRef: 'GREPTIMEDB_DP0_USERNAME',
      passwordRef: 'GREPTIMEDB_DP0_PASSWORD',
      envName: '',
    })).toEqual([
      { key: 'endpoint', label: '服务地址', value: 'https://greptimedb.dev' },
      { key: 'database', label: '数据库', value: 'public' },
    ])
  })
})

describe('catalogRefs / chunkRefs（describe 拉取计划）', () => {
  it('包含环境腿键与平台级全局键，排序去重', () => {
    const refs = catalogRefs(matrix)
    expect(refs).toEqual([...new Set(refs)].sort())
    for (const expected of [
      'ZADIG_API_TOKEN',
      'GREPTIMEDB_PBO_CONNECT_TOKEN',
      'TAPD_TOKEN',
      'DSH_SENTRY_CODE_BASE',
    ]) {
      expect(refs).toContain(expected)
    }
    expect(refs).not.toContain(DEFAULT_ENV_REF)
  })

  it(`chunkRefs 保持顺序且每段 ≤${DESCRIBE_CHUNK}（宿主 MAX_DESCRIBE_REFS）`, () => {
    expect(chunkRefs([])).toEqual([])
    const refs = Array.from({ length: DESCRIBE_CHUNK * 2 + 3 }, (_, index) => `REF_${index}`)
    const chunks = chunkRefs(refs)
    expect(chunks.map(chunk => chunk.length)).toEqual([DESCRIBE_CHUNK, DESCRIBE_CHUNK, 3])
    expect(chunks.flat()).toEqual(refs)
  })
})

describe('globalCredentialViews（全局配置）', () => {
  it('展示所有环境共用键与平台级键；token 不投影值，代码根目录展示实际路径', () => {
    const rows = globalCredentialViews(matrix, statusOf(['ZADIG_API_TOKEN']), {
      codeBaseDir: '/store/novoone-backend',
    })
    const zadig = rows.find(row => row.ref === 'ZADIG_API_TOKEN')
    expect(zadig).toMatchObject({
      label: 'Zadig OpenAPI Token',
      description: '所有环境共用同一键',
      value: undefined,
      info: { configured: true },
    })
    const tapd = rows.find(row => row.ref === 'TAPD_TOKEN')
    expect(tapd?.description).toBe('平台级凭据，不随环境变化')
    expect(tapd?.info?.configured).toBeUndefined()
    const codeBase = rows.find(row => row.ref === 'DSH_SENTRY_CODE_BASE')
    expect(codeBase).toMatchObject({
      label: '代码检索根目录',
      value: '/store/novoone-backend',
      info: undefined,
    })
  })
})

describe('defaultEnvView（默认环境只读展示）', () => {
  it('宿主信息未加载时保持空态', () => {
    expect(defaultEnvView()).toEqual({
      preference: undefined,
      effectiveEnv: undefined,
      assemblyEnv: undefined,
      source: undefined,
    })
  })

  it('有效本机偏好与实际生效值一致时标记来源为 preference', () => {
    const view = defaultEnvView({
      preference: 'dev-platform-hosted-0',
      effectiveEnv: 'dev-platform-hosted-0',
      assemblyEnv: 'tst-platform-hosted-0',
    })
    expect(view).toMatchObject({
      preference: 'dev-platform-hosted-0',
      effectiveEnv: 'dev-platform-hosted-0',
      assemblyEnv: 'tst-platform-hosted-0',
      source: 'preference',
    })
  })

  it('未设置偏好或偏好失效时展示装配来源与实际生效值', () => {
    expect(defaultEnvView({ effectiveEnv: 'tst-platform-hosted-0', assemblyEnv: 'tst-platform-hosted-0' }))
      .toMatchObject({ preference: undefined, effectiveEnv: 'tst-platform-hosted-0', source: 'assembly' })
    expect(defaultEnvView({
      preference: 'removed-env',
      effectiveEnv: 'tst-platform-hosted-0',
      assemblyEnv: 'tst-platform-hosted-0',
    })).toMatchObject({ preference: 'removed-env', effectiveEnv: 'tst-platform-hosted-0', source: 'assembly' })
  })
})

describe('generated-matrix 冒烟（嵌入矩阵结构）', () => {
  it('覆盖 envs.yml 全部环境且别名可反向命中', () => {
    const envs = Object.keys(MATRIX)
    expect(envs.length).toBeGreaterThanOrEqual(17)
    for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
      expect(envs, `别名 ${alias}`).toContain(canonical)
    }
  })

  it('每行六条腿齐全且只携带 *Ref 引用名，不携带凭据值', () => {
    for (const [env, row] of Object.entries(MATRIX)) {
      for (const leg of ['greptimedb', 'grafana', 'prometheus', 'dbx', 'rocketmq', 'zadig'] as const) {
        expect(row[leg], `${env}.${leg}`).toBeDefined()
      }
      expect(row.zadig.tokenRef, `${env}.zadig.tokenRef`).toBe('ZADIG_API_TOKEN')
    }
    const text = JSON.stringify(MATRIX)
    expect(text).not.toMatch(/"(password|token|secret)"\s*:\s*"(?![A-Z0-9_]+_)([^"]+)"/i)
  })

  it('PBO 为 greptimedb token 模式（connect token），矩阵与 pure 推导一致', () => {
    const row = MATRIX['pro-br-saas-aws-eks-novo']!
    expect(row.greptimedb.tokenRef).toBe('GREPTIMEDB_PBO_CONNECT_TOKEN')
    expect(row.greptimedb.usernameRef).toBeUndefined()
  })
})
