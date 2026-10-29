import { describe, expect, it } from 'vitest'
import type { EnvRow } from '../src/index.ts'
import { legCredentialRefs, legReadiness, matrixCredentialRefs } from '../src/pure.ts'

const basicRow: EnvRow = {
  envLabel: 'test',
  greptimedb: {
    endpoint: 'https://greptimedb.test',
    usernameRef: 'GREPTIMEDB_TEST_USERNAME',
    passwordRef: 'GREPTIMEDB_TEST_PASSWORD',
  },
  grafana: {
    endpoint: 'https://grafana.test',
    usernameRef: 'GRAFANA_TEST_USERNAME',
    passwordRef: 'GRAFANA_TEST_PASSWORD',
  },
  prometheus: { datasourceUid: 'prometheus' },
  dbx: { endpoint: 'https://dbx.test', passwordRef: 'DBX_TEST_PASSWORD' },
  rocketmq: {
    endpoint: 'https://rocketmq.test',
    usernameRef: 'ROCKETMQ_TEST_USERNAME',
    passwordRef: 'ROCKETMQ_TEST_PASSWORD',
  },
  zadig: { endpoint: 'https://zadig.test', project: 'p', envName: 'test', tokenRef: 'ZADIG_API_TOKEN' },
}

const tokenRow: EnvRow = {
  ...basicRow,
  greptimedb: {
    endpoint: 'https://greptimedb.test',
    tokenRef: 'GREPTIMEDB_TEST_TOKEN',
  },
}

describe('legReadiness（纯推导）', () => {
  it('全值就绪时每条腿 ok', () => {
    const legs = legReadiness(basicRow, () => true)
    expect(legs.map(leg => leg.leg)).toEqual(['greptimedb', 'grafana', 'dbx', 'rocketmq', 'zadig'])
    expect(legs.every(leg => leg.ok)).toBe(true)
    // prometheus 未配 tokenRef（统一走 grafana 表单登录），不产生独立腿
  })

  it('缺值只降级对应腿并列出 missingRefs', () => {
    const legs = legReadiness(basicRow, ref => !ref.includes('GRAFANA'))
    const grafana = legs.find(leg => leg.leg === 'grafana')
    expect(grafana?.ok).toBe(false)
    expect(grafana?.missingRefs).toEqual(['GRAFANA_TEST_USERNAME', 'GRAFANA_TEST_PASSWORD'])
    expect(legs.find(leg => leg.leg === 'greptimedb')?.ok).toBe(true)
  })

  it('greptimedb tokenRef 定义即 token 模式，忽略残留账密引用', () => {
    const legs = legReadiness(tokenRow, ref => ref === 'GREPTIMEDB_TEST_TOKEN')
    const greptimedb = legs.find(leg => leg.leg === 'greptimedb')
    expect(greptimedb?.authMode).toBe('token')
    expect(greptimedb?.missingRefs).toEqual([])
    expect(greptimedb?.ok).toBe(true)
  })

  it('greptimedb 账密模式在部分缺值时列出所缺键', () => {
    const legs = legReadiness(basicRow, ref => ref !== 'GREPTIMEDB_TEST_PASSWORD')
    const greptimedb = legs.find(leg => leg.leg === 'greptimedb')
    expect(greptimedb?.authMode).toBe('basic')
    expect(greptimedb?.missingRefs).toEqual(['GREPTIMEDB_TEST_PASSWORD'])
  })
})

describe('legCredentialRefs（形状视图，与就绪无关）', () => {
  it('每条配置了引用的腿列出全部接线键，无论是否就绪', () => {
    const legs = legCredentialRefs(basicRow)
    expect(legs.find(leg => leg.leg === 'grafana')?.refs).toEqual(['GRAFANA_TEST_USERNAME', 'GRAFANA_TEST_PASSWORD'])
    expect(legs.find(leg => leg.leg === 'zadig')?.refs).toEqual(['ZADIG_API_TOKEN'])
  })

  it('greptimedb token 模式只列 token 键', () => {
    const legs = legCredentialRefs(tokenRow)
    expect(legs.find(leg => leg.leg === 'greptimedb')?.refs).toEqual(['GREPTIMEDB_TEST_TOKEN'])
  })

  it('与 legReadiness 的腿集合一致（同一接线规则的两面）', () => {
    for (const row of [basicRow, tokenRow]) {
      expect(legCredentialRefs(row).map(entry => entry.leg))
        .toEqual(legReadiness(row, () => true).map(entry => entry.leg))
    }
  })
})

describe('matrixCredentialRefs（目录并集）', () => {
  it('合并各环境腿键与平台级键，去重排序', () => {
    const refs = matrixCredentialRefs({
      'env-a': basicRow,
      'env-b': tokenRow,
    })
    expect(refs).toContain('TAPD_TOKEN')
    expect(refs).toContain('DSH_SENTRY_CODE_BASE')
    expect(refs).toContain('GREPTIMEDB_TEST_TOKEN')
    expect(refs).toContain('ZADIG_API_TOKEN')
    expect([...refs].sort()).toEqual(refs)
    // ZADIG_API_TOKEN 在两个环境行都出现，只保留一份
    expect(refs.filter(ref => ref === 'ZADIG_API_TOKEN')).toHaveLength(1)
  })
})
