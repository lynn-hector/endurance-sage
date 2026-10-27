import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Matrix } from '@dsh-sentry/env-matrix'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import {
  listEnvironments,
  resolveRuntimeConfig,
} from '../src/environment.ts'
import { apply } from '../src/index.ts'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec?: unknown): Promise<JsonValue>
}

const matrix: Matrix = {
  'dev-platform-hosted-0': {
    envLabel: 'dev-platform-hosted-0',
    greptimedb: {
      endpoint: 'https://greptimedb.cn-0.dev.novo-one.com',
      usernameRef: 'GREPTIMEDB_DP0_USERNAME',
      passwordRef: 'GREPTIMEDB_DP0_PASSWORD',
    },
    grafana: {
      endpoint: 'https://grafana.cn-0.dev.novo-one.com',
      usernameRef: 'GRAFANA_DP0_USERNAME',
      passwordRef: 'GRAFANA_DP0_PASSWORD',
    },
    prometheus: { datasourceUid: 'prometheus' },
    dbx: { endpoint: 'https://dbx.cn-0.dev.novo-one.com', passwordRef: 'DBX_DP0_PASSWORD' },
    rocketmq: {
      endpoint: 'https://rocketmq.cn-0.dev.novo-one.com',
      usernameRef: 'ROCKETMQ_DP0_USERNAME',
      passwordRef: 'ROCKETMQ_DP0_PASSWORD',
    },
    zadig: {
      endpoint: 'https://zadig.yeastardigital.com',
      project: 'novo-one-helm-charts-project',
      envName: 'dev-platform-hosted-0',
      tokenRef: 'ZADIG_API_TOKEN',
    },
  },
  'tst-platform-hosted-0': {
    envLabel: 'tst-platform-hosted-0',
    greptimedb: {
      endpoint: 'https://greptimedb.cn-0.test.novo-one.com',
      usernameRef: 'GREPTIMEDB_TP0_USERNAME',
      passwordRef: 'GREPTIMEDB_TP0_PASSWORD',
    },
    grafana: {
      endpoint: 'https://grafana.cn-0.test.novo-one.com',
      usernameRef: 'GRAFANA_TP0_USERNAME',
      passwordRef: 'GRAFANA_TP0_PASSWORD',
    },
    prometheus: { datasourceUid: 'prometheus' },
    dbx: { endpoint: 'https://dbx.cn-0.test.novo-one.com', passwordRef: 'DBX_TP0_PASSWORD' },
    rocketmq: {
      endpoint: 'https://rocketmq.cn-0.test.novo-one.com',
      usernameRef: 'ROCKETMQ_TP0_USERNAME',
      passwordRef: 'ROCKETMQ_TP0_PASSWORD',
    },
    zadig: {
      endpoint: 'https://zadig.yeastardigital.com',
      project: 'novo-one-helm-charts-project',
      envName: 'tst-platform-hosted-0',
      tokenRef: 'ZADIG_API_TOKEN',
    },
  },
}

let dir: string
let config: ReturnType<typeof resolveRuntimeConfig>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-switcher-'))
  const envsPath = join(dir, 'envs.yml')
  const credentialStorePath = join(dir, '.credentials.yaml')
  writeFileSync(envsPath, JSON.stringify(matrix))
  writeFileSync(credentialStorePath, [
    'GREPTIMEDB_DP0_USERNAME: user',
    'GREPTIMEDB_DP0_PASSWORD: secret',
    'GRAFANA_DP0_USERNAME: user',
    'GRAFANA_DP0_PASSWORD: secret',
    'DBX_DP0_PASSWORD: secret',
    'ROCKETMQ_DP0_USERNAME: user',
    'ROCKETMQ_DP0_PASSWORD: secret',
    'ZADIG_API_TOKEN: token',
    'GREPTIMEDB_TP0_USERNAME: user',
    'GREPTIMEDB_TP0_PASSWORD: secret',
    'DBX_TP0_PASSWORD: secret',
    'ROCKETMQ_TP0_USERNAME: user',
    'ROCKETMQ_TP0_PASSWORD: secret',
  ].join('\n'))
  config = resolveRuntimeConfig({ envsPath, credentialStorePath })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('environment tools', () => {
  it('lists aliases and missing credential refs without exposing values', () => {
    const result = listEnvironments(config)
    expect(result).not.toHaveProperty('current')
    const tp0 = result.environments.find(environment => environment.name === 'tst-platform-hosted-0')
    expect(tp0?.aliases).toContain('TP0')
    expect(tp0?.missingCredentialRefs).toEqual(['GRAFANA_TP0_USERNAME', 'GRAFANA_TP0_PASSWORD'])
    expect(tp0?.degradedLegs).toEqual(['grafana'])
  })

  it('resolves credential keys nested under the refs mapping (real store schema)', () => {
    const nestedStorePath = join(dir, '.credentials.nested.yaml')
    writeFileSync(nestedStorePath, [
      'version: 1',
      'refs:',
      '  GREPTIMEDB_DP0_USERNAME: user',
      '  GREPTIMEDB_DP0_PASSWORD: secret',
      '  GRAFANA_DP0_USERNAME: user',
      '  GRAFANA_DP0_PASSWORD: secret',
      '  DBX_DP0_PASSWORD: secret',
      '  ROCKETMQ_DP0_USERNAME: user',
      '  ROCKETMQ_DP0_PASSWORD: secret',
      '  ZADIG_API_TOKEN: token',
      'records: []',
    ].join('\n'))
    const nestedConfig = resolveRuntimeConfig({ ...config, credentialStorePath: nestedStorePath })
    const listed = listEnvironments(nestedConfig)
    const dp0 = listed.environments.find(environment => environment.name === 'dev-platform-hosted-0')
    expect(dp0?.ready).toBe(true)
    expect(dp0?.missingCredentialRefs).toEqual([])
  })

  it('registers the list, current, and switch tools over the session binding', async () => {
    const registered: RegisteredTool[] = []
    const bound = { env: 'dev-platform-hosted-0' }
    apply({
      tools: { register: (tool: RegisteredTool) => registered.push(tool) },
      envBinding: {
        // 直接调用 apply（不经插件装载）：envBinding 按当前 Session 绑定应答
        current: async () => bound,
        switch: async () => { throw new Error('not asserted here') },
      },
    } as unknown as Context, {
      env: 'dev-platform-hosted-0',
      envsPath: config.envsPath,
      credentialStorePath: config.credentialStorePath,
    })
    expect(registered.map(tool => tool.name)).toEqual([
      'sentry_env_list',
      'sentry_env_current',
      'sentry_env_switch',
    ])
    const exec = { agent: { session: {} } } as never
    const current = await registered[1]!.execute({}, exec)
    expect(current).toMatchObject({ current: 'dev-platform-hosted-0' })
    const list = await registered[0]!.execute({}, exec)
    expect(list).toMatchObject({ current: 'dev-platform-hosted-0' })
  })
})
