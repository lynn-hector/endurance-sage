import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Matrix } from '@dsh-sentry/env-matrix'
import { extractCurrentEnv } from '@dsh-sentry/env-matrix'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import {
  currentEnvironment,
  listEnvironments,
  resolveRuntimeConfig,
  switchEnvironment,
} from '../src/environment.ts'
import { apply } from '../src/index.ts'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>): Promise<JsonValue>
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
let directProfileConfig: ReturnType<typeof resolveRuntimeConfig>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-switcher-'))
  const envsPath = join(dir, 'envs.yml')
  const credentialStorePath = join(dir, '.credentials.yaml')
  const patchPath = join(dir, 'cordis.patch.yml')
  const includePath = join(dir, 'cordis.include.yml')
  const profilePatchPath = join(dir, 'profile/cordis.patch.yml')
  const directProfilePatchPath = join(dir, 'direct-profile/cordis.patch.yml')
  mkdirSync(join(dir, 'profile'))
  mkdirSync(join(dir, 'direct-profile'))
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
  writeFileSync(includePath, '# dsh-sentry 组装（env: dev-platform-hosted-0，include 格式）\n')
  writeFileSync(profilePatchPath, '# sentry 核心经 cordis-plugin-include 引入\n')
  writeFileSync(directProfilePatchPath, '# dsh-sentry 组装（env: dev-platform-hosted-0）\n')
  config = resolveRuntimeConfig({
    env: 'dev-platform-hosted-0',
    envsPath,
    patchPath,
    includePath,
    profilePatchPath,
    credentialStorePath,
  })
  directProfileConfig = resolveRuntimeConfig({ ...config, profilePatchPath: directProfilePatchPath })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('environment tools', () => {
  it('lists aliases and missing credential refs without exposing values', () => {
    const result = listEnvironments(config)
    expect(result.current).toBe('dev-platform-hosted-0')
    const tp0 = result.environments.find(environment => environment.name === 'tst-platform-hosted-0')
    expect(tp0?.aliases).toContain('TP0')
    expect(tp0?.missingCredentialRefs).toEqual(['GRAFANA_TP0_USERNAME', 'GRAFANA_TP0_PASSWORD'])
    expect(tp0?.degradedLegs).toEqual(['grafana'])
  })

  it('switches with degraded legs reported instead of refusing', () => {
    const result = switchEnvironment('TP0', config, { now: () => '2026-08-27T00:00:00.000Z' })
    expect(result).toMatchObject({
      ok: true,
      environment: 'tst-platform-hosted-0',
      degradedLegs: [{ leg: 'grafana', missingRefs: ['GRAFANA_TP0_USERNAME', 'GRAFANA_TP0_PASSWORD'] }],
    })
    // 切换照常写入装配文件：缺凭据只降级该腿，不再拦截
    expect(readFileSync(config.includePath, 'utf8')).toContain('env: tst-platform-hosted-0')
  })

  it('switches by canonical name and reports pending hot reload', () => {
    const result = switchEnvironment('dev-platform-hosted-0', config, { now: () => '2026-08-27T00:00:00.000Z' })
    expect(result).toMatchObject({ ok: true, environment: 'dev-platform-hosted-0', aliases: ['DP0'] })
    // Assembly files are a pure function of envs.yml — no timestamp comment.
    const written = readFileSync(config.includePath, 'utf8')
    expect(written).not.toContain('环境切换时间')
    expect(written).toContain('env: dev-platform-hosted-0')
    expect(currentEnvironment(config)).toMatchObject({
      current: 'dev-platform-hosted-0',
      loadedEnv: 'dev-platform-hosted-0',
      hotReloadPending: false,
    })
  })

  it('syncs direct profile assemblies without overwriting include stubs', () => {
    const direct = switchEnvironment('DP0', directProfileConfig, { now: () => '2026-08-27T01:00:00.000Z' })
    expect(direct).toMatchObject({
      ok: true,
      writtenPaths: expect.arrayContaining([directProfileConfig.profilePatchPath]),
    })
    expect(extractCurrentEnv(readFileSync(directProfileConfig.profilePatchPath, 'utf8')))
      .toBe('dev-platform-hosted-0')

    const includeMode = switchEnvironment('DP0', config, { now: () => '2026-08-27T02:00:00.000Z' })
    expect(includeMode).toMatchObject({ ok: true })
    expect(readFileSync(config.profilePatchPath, 'utf8')).toContain('cordis-plugin-include 引入')
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
    expect(switchEnvironment('DP0', nestedConfig, { dryRun: true })).toMatchObject({
      ok: true,
      environment: 'dev-platform-hosted-0',
    })
  })

  it('registers the list, current, and switch tools', async () => {
    const registered: RegisteredTool[] = []
    apply({
      tools: { register: (tool: RegisteredTool) => registered.push(tool) },
    } as unknown as Context, {
      env: 'dev-platform-hosted-0',
      envsPath: config.envsPath,
      patchPath: config.patchPath,
      includePath: config.includePath,
      profilePatchPath: config.profilePatchPath,
      credentialStorePath: config.credentialStorePath,
    })
    expect(registered.map(tool => tool.name)).toEqual([
      'sentry_env_list',
      'sentry_env_current',
      'sentry_env_switch',
    ])
    const current = await registered[1]!.execute({})
    expect(current).toMatchObject({ current: 'dev-platform-hosted-0' })
  })
})
