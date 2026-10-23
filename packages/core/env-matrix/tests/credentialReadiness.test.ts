import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EnvRow } from '../src/index.ts'
import { credentialReadiness } from '../src/index.ts'

const row: EnvRow = {
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
  zadig: {
    endpoint: 'https://zadig.test',
    project: 'p',
    envName: 'test',
    tokenRef: 'ZADIG_API_TOKEN',
  },
}

const tokenRow: EnvRow = {
  ...row,
  greptimedb: {
    endpoint: 'https://greptimedb.test',
    tokenRef: 'GREPTIMEDB_TEST_CONNECT_TOKEN',
  },
}

let dir: string
let storePath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-credential-readiness-'))
  storePath = join(dir, '.credentials.yaml')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => vi.unstubAllEnvs())

/** 写入扁平或 refs 嵌套结构的凭据库。 */
function store(lines: string[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(storePath, `${lines.join('\n')}\n`)
}

function legOf(legs: ReturnType<typeof credentialReadiness>, name: string) {
  return legs.find(item => item.leg === name)
}

describe('credentialReadiness', () => {
  it('marks every leg ready when all referenced values are non-empty', () => {
    store([
      'GREPTIMEDB_TEST_USERNAME: user',
      'GREPTIMEDB_TEST_PASSWORD: secret',
      'GRAFANA_TEST_USERNAME: user',
      'GRAFANA_TEST_PASSWORD: secret',
      'DBX_TEST_PASSWORD: secret',
      'ROCKETMQ_TEST_USERNAME: user',
      'ROCKETMQ_TEST_PASSWORD: secret',
      'ZADIG_API_TOKEN: token',
    ])
    const legs = credentialReadiness(row, storePath)
    expect(legs.map(item => item.leg)).toEqual(['greptimedb', 'grafana', 'dbx', 'rocketmq', 'zadig'])
    for (const item of legs) {
      expect(item.ok, item.leg).toBe(true)
      expect(item.missingRefs, item.leg).toEqual([])
    }
  })

  it('degrades only the legs whose values are absent — missing legs never hide ready ones', () => {
    store([
      'GREPTIMEDB_TEST_USERNAME: user',
      'GREPTIMEDB_TEST_PASSWORD: secret',
      'GRAFANA_TEST_USERNAME: user',
      'GRAFANA_TEST_PASSWORD: secret',
      'ZADIG_API_TOKEN: token',
    ])
    const legs = credentialReadiness(row, storePath)
    expect(legOf(legs, 'greptimedb')?.ok).toBe(true)
    expect(legOf(legs, 'grafana')?.ok).toBe(true)
    expect(legOf(legs, 'zadig')?.ok).toBe(true)
    expect(legOf(legs, 'dbx')).toMatchObject({ ok: false, missingRefs: ['DBX_TEST_PASSWORD'] })
    expect(legOf(legs, 'rocketmq')).toMatchObject({
      ok: false,
      missingRefs: ['ROCKETMQ_TEST_USERNAME', 'ROCKETMQ_TEST_PASSWORD'],
    })
  })

  it('treats empty and whitespace-only values as unconfigured', () => {
    store([
      'GREPTIMEDB_TEST_USERNAME: user',
      'GREPTIMEDB_TEST_PASSWORD: secret',
      'GRAFANA_TEST_USERNAME: user',
      'GRAFANA_TEST_PASSWORD: secret',
      'DBX_TEST_PASSWORD: ""',
      'ROCKETMQ_TEST_USERNAME: " "',
      'ROCKETMQ_TEST_PASSWORD: secret',
      'ZADIG_API_TOKEN: token',
    ])
    const legs = credentialReadiness(row, storePath)
    expect(legOf(legs, 'dbx')).toMatchObject({ ok: false, missingRefs: ['DBX_TEST_PASSWORD'] })
    expect(legOf(legs, 'rocketmq')).toMatchObject({ ok: false, missingRefs: ['ROCKETMQ_TEST_USERNAME'] })
  })

  it('counts process-env values as configured (non-empty only)', () => {
    store(['GRAFANA_TEST_USERNAME: user', 'GRAFANA_TEST_PASSWORD: secret', 'ZADIG_API_TOKEN: token'])
    vi.stubEnv('GREPTIMEDB_TEST_USERNAME', 'user')
    vi.stubEnv('GREPTIMEDB_TEST_PASSWORD', 'secret')
    vi.stubEnv('DBX_TEST_PASSWORD', '')
    const legs = credentialReadiness(row, storePath)
    expect(legOf(legs, 'greptimedb')?.ok).toBe(true)
    expect(legOf(legs, 'dbx')?.ok).toBe(false)
  })

  it('resolves values nested under the refs mapping (dsh store schema)', () => {
    store([
      'version: 1',
      'refs:',
      '  GREPTIMEDB_TEST_USERNAME: user',
      '  GREPTIMEDB_TEST_PASSWORD: secret',
      '  GRAFANA_TEST_USERNAME: user',
      '  GRAFANA_TEST_PASSWORD: secret',
      '  DBX_TEST_PASSWORD: secret',
      '  ROCKETMQ_TEST_USERNAME: user',
      '  ROCKETMQ_TEST_PASSWORD: secret',
      '  ZADIG_API_TOKEN: token',
    ])
    expect(credentialReadiness(row, storePath).every(item => item.ok)).toBe(true)
  })

  it('greptimedb token mode: ready on the connect token, authMode reported', () => {
    store([
      'GRAFANA_TEST_USERNAME: user',
      'GRAFANA_TEST_PASSWORD: secret',
      'DBX_TEST_PASSWORD: secret',
      'ROCKETMQ_TEST_USERNAME: user',
      'ROCKETMQ_TEST_PASSWORD: secret',
      'ZADIG_API_TOKEN: token',
    ])
    const missing = credentialReadiness(tokenRow, storePath)
    expect(legOf(missing, 'greptimedb')).toMatchObject({
      ok: false,
      authMode: 'token',
      missingRefs: ['GREPTIMEDB_TEST_CONNECT_TOKEN'],
    })

    store(['GREPTIMEDB_TEST_CONNECT_TOKEN: abc.def'])
    const ready = credentialReadiness(tokenRow, storePath)
    expect(legOf(ready, 'greptimedb')).toMatchObject({ ok: true, authMode: 'token' })
  })

  it('greptimedb with both token and basic refs wired evaluates token mode only (matches rendering)', () => {
    const dualRow: EnvRow = {
      ...row,
      greptimedb: {
        endpoint: 'https://greptimedb.test',
        tokenRef: 'GREPTIMEDB_TEST_CONNECT_TOKEN',
        usernameRef: 'GREPTIMEDB_TEST_USERNAME',
        passwordRef: 'GREPTIMEDB_TEST_PASSWORD',
      },
    }
    store(['GREPTIMEDB_TEST_USERNAME: user', 'GREPTIMEDB_TEST_PASSWORD: secret'])
    const legs = credentialReadiness(dualRow, storePath)
    expect(legOf(legs, 'greptimedb')).toMatchObject({
      ok: false,
      authMode: 'token',
      missingRefs: ['GREPTIMEDB_TEST_CONNECT_TOKEN'],
    })
  })

  it('skips legs that configure no credential refs', () => {
    const bareRow: EnvRow = {
      ...row,
      dbx: { endpoint: 'https://dbx.test' },
      rocketmq: { endpoint: 'https://rocketmq.test' },
    }
    store([])
    const legs = credentialReadiness(bareRow, storePath)
    expect(legs.map(item => item.leg)).toEqual(['greptimedb', 'grafana', 'zadig'])
  })

  it('degrades to an empty store instead of throwing on unparseable YAML (duplicate keys)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store(['GREPTIMEDB_TEST_USERNAME: user', 'GREPTIMEDB_TEST_USERNAME: user'])
    const legs = credentialReadiness(row, storePath)
    expect(legs.every(item => !item.ok)).toBe(true)
    expect(legs.every(item => item.missingRefs.length > 0)).toBe(true)
  })
})
