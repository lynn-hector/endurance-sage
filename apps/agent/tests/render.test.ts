import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parse } from 'yaml'
import { join } from 'node:path'
import { type EnvRow, renderEntries, renderProviderEntries, renderPatch, requiredCredentialRefs } from '../src/render.ts'

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
  kubernetes: {
    endpointRef: 'KUBERNETES_MCP_ENDPOINT',
    context: 'test',
  },
}

describe('renderEntries', () => {
  const entries = renderEntries(fixture)

  it('renders the 19 host plugins in dependency order', () => {
    expect(entries.map((e) => e.id)).toEqual([
      // 宿主级 Session 路由栈在最前：绑定存储 + Provider 池（环境无关条目）
      'sentry-env-binding',
      'sentry-env-provider',
      'sentry-tool-env-switcher',
      'sentry-tool-log-analyzer',
      'sentry-tool-callflow-analyzer',
      'sentry-tool-trace-analyzer',
      'sentry-tool-metrics-inspector',
      'sentry-tool-db-inspector',
      'sentry-tool-redis-inspector',
      'sentry-tool-zadig-inspector',
      'sentry-tool-kubernetes-inspector',
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

  it('carries no global Provider service entries — the pool owns per-env Providers', () => {
    const providerIds = new Set(renderProviderEntries(fixture).map((e) => e.id))
    for (const entry of entries) {
      expect(providerIds.has(entry.id), entry.id).toBe(false)
    }
  })

  it('carries env only on the switcher and evidence fallback consumers', () => {
    const entriesWithEnv = entries.filter(entry => entry.config?.['env'] !== undefined)
    expect(entriesWithEnv.map(entry => entry.id)).toEqual([
      'sentry-tool-env-switcher',
      'sentry-tool-tapd-inspector',
      'sentry-tool-code-repository',
    ])
    for (const entry of entriesWithEnv) expect(entry.config?.['env']).toBe('test')
  })

  it('keeps the default database on the db Consumer (caller intent, not Provider wiring)', () => {
    expect(entries.find((e) => e.id === 'sentry-tool-db-inspector')?.config).toEqual({
      database: 'novo_commctl_config',
    })
  })
})

describe('renderProviderEntries', () => {
  const providers = renderProviderEntries(fixture)

  it('renders the 8 Provider services the pool mounts per environment', () => {
    expect(providers.map((e) => e.id)).toEqual([
      'sentry-greptimedb',
      'sentry-trace',
      'sentry-prometheus',
      'sentry-alertmanager',
      'sentry-dbx',
      'sentry-zadig',
      'sentry-kubernetes',
      'sentry-service-rocketmq',
    ])
  })

  it('places log and callflow table configuration on the shared GreptimeDB Provider, not its Consumers', () => {
    const provider = providers.find((e) => e.id === 'sentry-greptimedb')

    expect(provider?.config).toMatchObject({
      endpoint: 'https://greptimedb.cn-0.test.novo-one.com',
      logSchema: 'public',
      logTable: 'k8s_logs',
      callflowSchema: 'public',
      callflowTable: 'hep_1',
    })
  })

  it('places Jaeger datasource configuration on the trace Provider', () => {
    const provider = providers.find((e) => e.id === 'sentry-trace')

    expect(provider?.config).toMatchObject({
      endpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'GreptimeDB-Jaeger',
    })
  })

  it('prometheus goes through the grafana proxy of this env', () => {
    const prometheus = providers.find((e) => e.id === 'sentry-prometheus')
    expect(prometheus?.config).toMatchObject({
      grafanaEndpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'prometheus',
      usernameRef: 'GRAFANA_TEST_USERNAME',
    })
  })

  it('renders the alertmanager service from the grafana leg', () => {
    const entry = providers.find((e) => e.id === 'sentry-alertmanager')
    expect(entry?.name).toBe('@dsh-sentry/service-alertmanager')
    expect(entry?.config).toEqual({
      grafanaEndpoint: 'https://grafana.cn-0.test.novo-one.com',
      datasourceUid: 'alertmanager',
      usernameRef: 'GRAFANA_TEST_USERNAME',
      passwordRef: 'GRAFANA_TEST_PASSWORD',
    })
  })

  it('renders the kubernetes leg from the row: gateway endpoint ref + pinned context, no credential values', () => {
    const entry = providers.find((e) => e.id === 'sentry-kubernetes')
    expect(entry?.name).toBe('@dsh-sentry/service-kubernetes')
    expect(entry?.config).toEqual({
      endpointRef: 'KUBERNETES_MCP_ENDPOINT',
      context: 'test',
    })
  })

  it('omits the kubernetes Provider entirely when the row carries no kubernetes block', () => {
    const { kubernetes: _kubernetes, ...legacyRow } = fixture
    const rendered = renderProviderEntries(legacyRow)
    expect(rendered.find((e) => e.id === 'sentry-kubernetes')).toBeUndefined()
    expect(rendered).toHaveLength(7)
  })

  it('no credential values anywhere — refs only', () => {
    const text = JSON.stringify(providers)
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
    const entry = renderProviderEntries(tokenRow).find((e) => e.id === 'sentry-greptimedb')
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
  it('collects exactly the nine refs an env needs', () => {
    expect(requiredCredentialRefs(fixture).sort()).toEqual([
      'DBX_TEST_PASSWORD',
      'GRAFANA_TEST_PASSWORD',
      'GRAFANA_TEST_USERNAME',
      'GREPTIMEDB_TEST_PASSWORD',
      'GREPTIMEDB_TEST_USERNAME',
      'KUBERNETES_MCP_ENDPOINT',
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
    expect(refs).toHaveLength(8)
  })
})

describe('code leg baseDir', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('omits the config entirely when no source configures it', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '')
    const service = renderEntries(fixture).find((e) => e.id === 'sentry-code-repository')
    const consumer = renderEntries(fixture).find((e) => e.id === 'sentry-tool-code-repository')
    expect(service?.config).toBeUndefined()
    expect(consumer?.config).toEqual({ env: 'test' })
  })

  it('never bakes machine-level sources (env var / credential store) — the service resolves them at runtime', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/tmp/novo-commctl')
    const entries = renderEntries(fixture)
    const service = entries.find((e) => e.id === 'sentry-code-repository')
    const consumer = entries.find((e) => e.id === 'sentry-tool-code-repository')
    expect(service?.config).toBeUndefined()
    expect(consumer?.config).toEqual({ env: 'test' })
  })

  it('renders only the committed envs.yml codeRepository.baseDir row (team config may enter the assembly)', () => {
    vi.stubEnv('DSH_SENTRY_CODE_BASE', '/tmp/from-env')
    const row: EnvRow = { ...fixture, codeRepository: { baseDir: '/tmp/from-matrix' } }
    const entry = renderEntries(row).find((e) => e.id === 'sentry-code-repository')
    expect(entry?.config).toEqual({ baseDir: '/tmp/from-matrix' })
  })

  it('expands a leading ~ in the row value — stored paths never pass through a shell', () => {
    const row: EnvRow = { ...fixture, codeRepository: { baseDir: '~/novoone-backend' } }
    const entry = renderEntries(row).find((e) => e.id === 'sentry-code-repository')
    expect(entry?.config).toEqual({ baseDir: join(homedir(), 'novoone-backend') })
  })
})

describe('renderPatch', () => {
  it('renders the aggregate bundle override plus the ui-settings Loader entry, round-tripping through the real parser', () => {
    const patch = renderPatch(fixture)
    const parsed = parse(patch) as { id: string; name: string; config?: Record<string, unknown> }[]
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({
      id: 'sentry',
      name: '@dsh-sentry/sentry',
      config: { defaultEnv: 'test' },
    })
    // ui-settings 是 profile 级 Loader 条目（web 设置页），随装配携带、无 config
    expect(parsed[1]).toMatchObject({ id: 'sentry-ui-settings', name: '@dsh-sentry/ui-settings' })
    expect(parsed[1]?.config).toBeUndefined()
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
      // kubernetes 腿可选但当前矩阵全量接线：context 与环境名 1:1；网关地址经凭据库
      // 解析（平台级共享单键）；tokenRef 预留给网关鉴权（启用后进入就绪推导与必备引用数）
      expect(row.kubernetes?.context, `${name}.kubernetes.context`).toBe(name)
      expect(row.kubernetes?.endpointRef, `${name}.kubernetes.endpointRef`).toBe('KUBERNETES_MCP_ENDPOINT')
      if (row.kubernetes?.tokenRef !== undefined) {
        expect(row.kubernetes.tokenRef, `${name}.kubernetes.tokenRef`).toMatch(/^[A-Z0-9_]+$/)
      }
      // 9 条必备引用：prometheus 腿统一走表单登录（grafana 账号密码）+ kubernetes
      // 网关地址键；greptimedb token 模式少一对账密
      expect(requiredCredentialRefs(row).length, `${name} refs`).toBe(greptimedbTokenMode ? 8 : 9)
    }
  })
})
