import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { join } from 'node:path'
import { type EnvRow, renderEntries, renderPatch, requiredCredentialRefs } from '../src/render.ts'

const fixture: EnvRow = {
  envLabel: 'test',
  greptimedb: {
    endpoint: 'https://greptimedb.cn-0.test.novo-one.com',
    database: 'public',
    usernameRef: 'GREPTIMEDB_TEST_USERNAME',
    passwordRef: 'GREPTIMEDB_TEST_PASSWORD',
  },
  grafana: {
    endpoint: 'https://grafana.cn-0.test.novo-one.com',
    datasourceUid: 'GreptimeDB-Jaeger',
    usernameRef: 'GRAFANA_TEST_USERNAME',
    passwordRef: 'GRAFANA_TEST_PASSWORD',
  },
  prometheus: { datasourceUid: 'prometheus' },
  dbx: { endpoint: 'https://dbx.cn-0.test.novo-one.com', passwordRef: 'DBX_TEST_PASSWORD' },
  rocketmq: {
    endpoint: 'https://rocketmq.cn-0.test.novo-one.com',
    usernameRef: 'ROCKETMQ_LOCAL_USERNAME',
    passwordRef: 'ROCKETMQ_LOCAL_PASSWORD',
  },
  zadig: {
    endpoint: 'https://zadig.yeastardigital.com',
    project: 'novo-one-helm-charts-project',
    envName: 'tst-platform-hosted-0',
    tokenRef: 'ZADIG_DEX_TOKEN',
  },
}

describe('renderEntries', () => {
  const entries = renderEntries(fixture)

  it('renders all 16 plugins in dependency order', () => {
    expect(entries.map((e) => e.id)).toEqual([
      'sentry-greptimedb',
      'sentry-tool-log-analyzer',
      'sentry-trace',
      'sentry-tool-trace-analyzer',
      'sentry-prometheus',
      'sentry-tool-metrics-inspector',
      'sentry-dbx',
      'sentry-tool-db-inspector',
      'sentry-tool-redis-inspector',
      'sentry-zadig',
      'sentry-tool-zadig-inspector',
      'sentry-service-rocketmq',
      'sentry-tool-mq-inspector',
      'sentry-tool-code-repository',
      'sentry-persona',
      'sentry-skills',
    ])
  })

  it('every tool config carries the env label', () => {
    const tools = entries.filter((e) => e.name.includes('tool-'))
    for (const tool of tools) expect(tool.config?.['env']).toBe('test')
  })

  it('prometheus goes through the grafana proxy of this env', () => {
    const prometheus = entries.find((e) => e.id === 'sentry-prometheus')
    expect(prometheus?.config).toMatchObject({
      endpoint: '',
      grafanaEndpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'prometheus',
      usernameRef: 'GRAFANA_TEST_USERNAME',
    })
  })

  it('no credential values anywhere — refs only', () => {
    const text = JSON.stringify(entries)
    expect(text).not.toMatch(/password:\s*['"]?\w/i)
    expect(text).not.toMatch(/"(username|password|token)":\s*"(?!.*Ref)/)
  })
})

describe('requiredCredentialRefs', () => {
  it('collects exactly the eight refs an env needs', () => {
    expect(requiredCredentialRefs(fixture).sort()).toEqual([
      'DBX_TEST_PASSWORD',
      'GRAFANA_TEST_PASSWORD',
      'GRAFANA_TEST_USERNAME',
      'GREPTIMEDB_TEST_PASSWORD',
      'GREPTIMEDB_TEST_USERNAME',
      'ROCKETMQ_LOCAL_PASSWORD',
      'ROCKETMQ_LOCAL_USERNAME',
      'ZADIG_DEX_TOKEN',
    ])
  })
})

describe('renderPatch', () => {
  it('emits YAML that round-trips through the real parser', () => {
    const patch = renderPatch(fixture)
    const parsed = parse(patch) as { insert: { id: string; config?: Record<string, unknown> }[] }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.insert).toHaveLength(16)
    const greptimedb = parsed[0]!.insert.find((e) => e.id === 'sentry-greptimedb')
    expect(greptimedb?.config?.['endpoint']).toBe('https://greptimedb.cn-0.test.novo-one.com')
    // empty-string endpoint stays a string, not null
    const prometheus = parsed[0]!.insert.find((e) => e.id === 'sentry-prometheus')
    expect(prometheus?.config?.['endpoint']).toBe('')
  })
})

describe('envs.yml contract', () => {
  it('the real matrix parses and every row passes the readiness contract shape', () => {
    const matrix = parse(readFileSync(join(import.meta.dirname, '..', 'envs.yml'), 'utf8')) as Record<string, EnvRow>
    for (const [name, row] of Object.entries(matrix)) {
      expect(row.envLabel, `${name}.envLabel`).toBe(name)
      expect(row.greptimedb.usernameRef, `${name}.greptimedb.usernameRef`).toMatch(/^[A-Z0-9_]+$/)
      expect(row.zadig.tokenRef, `${name}.zadig.tokenRef`).toMatch(/^[A-Z0-9_]+$/)
      expect(requiredCredentialRefs(row).length, `${name} refs`).toBe(8)
    }
  })
})
