import { afterEach, describe, expect, it, vi } from 'vitest'
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
    greptimedbJaegerDatasourceUid: 'GreptimeDB-Jaeger',
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
    tokenRef: 'ZADIG_API_TOKEN',
  },
}

describe('renderEntries', () => {
  const entries = renderEntries(fixture)

  it('renders all 25 plugins in dependency order', () => {
    expect(entries.map((e) => e.id)).toEqual([
      // 宿主级 Session 路由栈在最前：绑定存储 + Provider 池（环境无关条目）
      'sentry-env-binding',
      'sentry-env-provider',
      'sentry-tool-env-switcher',
      'sentry-greptimedb',
      'sentry-tool-log-analyzer',
      'sentry-tool-callflow-analyzer',
      'sentry-trace',
      'sentry-tool-trace-analyzer',
      'sentry-prometheus',
      'sentry-alertmanager',
      'sentry-tool-metrics-inspector',
      'sentry-dbx',
      'sentry-tool-db-inspector',
      'sentry-tool-redis-inspector',
      'sentry-zadig',
      'sentry-tool-zadig-inspector',
      'sentry-service-rocketmq',
      'sentry-tool-mq-inspector',
      'sentry-tapd',
      'sentry-tool-tapd-inspector',
      'sentry-code-repository',
      'sentry-tool-code-repository',
      'sentry-persona',
      'sentry-skills',
      'sentry-git-guard',
    ])
  })

  it('only the env-switcher entry carries env — the single assembly anchor', () => {
    const switcher = entries.find((e) => e.id === 'sentry-tool-env-switcher')
    expect(switcher?.config?.['env']).toBe('test')
    for (const entry of entries.filter((e) => e.id !== 'sentry-tool-env-switcher')) {
      expect(entry.config?.['env'], entry.id).toBeUndefined()
    }
  })

  it('places log and callflow table configuration on the shared GreptimeDB Provider, not its Consumers', () => {
    const provider = entries.find((e) => e.id === 'sentry-greptimedb')
    const logConsumer = entries.find((e) => e.id === 'sentry-tool-log-analyzer')
    const callflowConsumer = entries.find((e) => e.id === 'sentry-tool-callflow-analyzer')

    expect(provider?.config).toMatchObject({
      endpoint: 'https://greptimedb.cn-0.test.novo-one.com',
      logSchema: 'public',
      logTable: 'k8s_logs',
      callflowSchema: 'public',
      callflowTable: 'hep_1',
    })
    expect(logConsumer?.config).toBeUndefined()
    expect(callflowConsumer?.config).toBeUndefined()
  })

  it('places Jaeger datasource configuration on the trace Provider, not its Consumer', () => {
    const provider = entries.find((e) => e.id === 'sentry-trace')
    const consumer = entries.find((e) => e.id === 'sentry-tool-trace-analyzer')

    expect(provider?.config).toMatchObject({
      endpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'GreptimeDB-Jaeger',
    })
    expect(consumer?.config).toBeUndefined()
  })

  it('prometheus goes through the grafana proxy of this env', () => {
    const prometheus = entries.find((e) => e.id === 'sentry-prometheus')
    expect(prometheus?.config).toMatchObject({
      grafanaEndpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'prometheus',
      usernameRef: 'GRAFANA_TEST_USERNAME',
    })
  })

  it('renders the alertmanager service from the grafana leg', () => {
    const entry = entries.find((e) => e.id === 'sentry-alertmanager')
    expect(entry?.name).toBe('@dsh-sentry/service-alertmanager')
    expect(entry?.config).toEqual({
      grafanaEndpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'alertmanager',
      usernameRef: 'GRAFANA_TEST_USERNAME',
      passwordRef: 'GRAFANA_TEST_PASSWORD',
    })
  })

  it('no credential values anywhere — refs only', () => {
    const text = JSON.stringify(entries)
    expect(text).not.toMatch(/password:\s*['"]?\w/i)
    expect(text).not.toMatch(/"(username|password|token)":\s*"(?!.*Ref)/)
  })

  it('greptimedb token mode renders connectTokenRef only — no username/password refs', () => {
    const tokenRow: EnvRow = {
      ...fixture,
      greptimedb: {
        endpoint: 'https://greptimedb.br.novoone.com',
        database: 'public',
        tokenRef: 'GREPTIMEDB_TEST_CONNECT_TOKEN',
      },
    }
    const entry = renderEntries(tokenRow).find((e) => e.id === 'sentry-greptimedb')
    expect(entry?.config).toMatchObject({
      endpoint: 'https://greptimedb.br.novoone.com',
      database: 'public',
      connectTokenRef: 'GREPTIMEDB_TEST_CONNECT_TOKEN',
    })
    expect(entry?.config).not.toHaveProperty('usernameRef')
    expect(entry?.config).not.toHaveProperty('passwordRef')
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
      'ZADIG_API_TOKEN',
    ])
  })

  it('swaps the greptimedb pair for the single connect-token ref in token mode', () => {
    const tokenRow: EnvRow = {
      ...fixture,
      greptimedb: {
        endpoint: 'https://greptimedb.br.novoone.com',
        database: 'public',
        tokenRef: 'GREPTIMEDB_TEST_CONNECT_TOKEN',
      },
    }
    const refs = requiredCredentialRefs(tokenRow)
    expect(refs).toContain('GREPTIMEDB_TEST_CONNECT_TOKEN')
    expect(refs).not.toContain('GREPTIMEDB_TEST_USERNAME')
    expect(refs).toHaveLength(7)
  })
})

describe('code leg baseDir', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('omits the config entirely when no source configures it', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '')
    const service = renderEntries(fixture).find((e) => e.id === 'sentry-code-repository')
    const consumer = renderEntries(fixture).find((e) => e.id === 'sentry-tool-code-repository')
    expect(service?.config).toBeUndefined()
    expect(consumer?.config).toBeUndefined()
  })

  it('bakes DSH_SENTRY_CODE_BASE into the service Provider, not its Consumer', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/tmp/novo-commctl')
    const entries = renderEntries(fixture)
    const service = entries.find((e) => e.id === 'sentry-code-repository')
    const consumer = entries.find((e) => e.id === 'sentry-tool-code-repository')
    expect(service?.config).toEqual({ baseDir: '/tmp/novo-commctl' })
    expect(consumer?.config).toBeUndefined()
  })

  it('envs.yml codeRepository.baseDir wins over the environment variable', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/tmp/from-env')
    const row: EnvRow = { ...fixture, codeRepository: { baseDir: '/tmp/from-matrix' } }
    const entry = renderEntries(row).find((e) => e.id === 'sentry-code-repository')
    expect(entry?.config).toEqual({ baseDir: '/tmp/from-matrix' })
  })
})

describe('renderPatch', () => {
  it('emits YAML that round-trips through the real parser', () => {
    const patch = renderPatch(fixture)
    const parsed = parse(patch) as { insert: { id: string; config?: Record<string, unknown> }[] }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.insert).toHaveLength(25)
    const greptimedb = parsed[0]!.insert.find((e) => e.id === 'sentry-greptimedb')
    expect(greptimedb?.config?.['endpoint']).toBe('https://greptimedb.cn-0.test.novo-one.com')
    // direct endpoint field is absent in proxy mode (optional since day one
    // of the matrix; grafanaEndpoint is the only wiring)
    const prometheus = parsed[0]!.insert.find((e) => e.id === 'sentry-prometheus')
    expect(prometheus?.config?.['endpoint']).toBeUndefined()
    // Number-like strings must survive the round trip as strings.
    const tapd = parsed[0]!.insert.find((e) => e.id === 'sentry-tapd')
    expect(tapd?.config?.['workspaceId']).toBe('63822673')
  })

  it('keeps the header minimal: env marker + regen pointer, no inline commentary', () => {
    const patch = renderPatch(fixture)
    expect(patch).toContain('# dsh-sentry 组装（env: test）——由 apps/agent/envs.yml 生成，勿手改。')
    expect(patch).toContain('# 修改入口：apps/agent/envs.yml；重新生成：pnpm --filter @dsh-sentry/agent run regenerate')
    expect(patch).not.toMatch(/^    # /m)
  })
})

describe('envs.yml contract', () => {
  it('the real matrix parses and every row passes the readiness contract shape', () => {
    const matrix = parse(readFileSync(join(import.meta.dirname, '..', 'envs.yml'), 'utf8')) as Record<string, EnvRow>
    for (const [name, row] of Object.entries(matrix)) {
      expect(row.envLabel, `${name}.envLabel`).toBe(name)
      // greptimedb 腿两种模式：账密引用，或 connect token 引用（token 模式省略账密）
      const greptimedbTokenMode = row.greptimedb.tokenRef !== undefined
      if (greptimedbTokenMode) {
        expect(row.greptimedb.tokenRef, `${name}.greptimedb.tokenRef`).toMatch(/^[A-Z0-9_]+$/)
      } else {
        expect(row.greptimedb.usernameRef, `${name}.greptimedb.usernameRef`).toMatch(/^[A-Z0-9_]+$/)
        expect(row.greptimedb.passwordRef, `${name}.greptimedb.passwordRef`).toMatch(/^[A-Z0-9_]+$/)
      }
      expect(row.zadig.tokenRef, `${name}.zadig.tokenRef`).toMatch(/^[A-Z0-9_]+$/)
      // 8 条必备引用：prometheus 腿统一走表单登录（grafana 账号密码），
      // 不再为禁 basic auth 的实例配 service account token
      expect(requiredCredentialRefs(row).length, `${name} refs`).toBe(greptimedbTokenMode ? 7 : 8)
    }
  })
})
