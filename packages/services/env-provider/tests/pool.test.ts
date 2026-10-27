import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Matrix } from '@dsh-sentry/env-matrix'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EnvProviderPool } from '../src/pool.ts'

const DP0 = 'dev-platform-hosted-0'
const TP0 = 'tst-platform-hosted-0'

function row(envLabel: string, endpoint: string): Matrix[string] {
  return {
    envLabel,
    greptimedb: {},
    grafana: {},
    prometheus: {},
    dbx: { endpoint, passwordRef: `DBX_${envLabel}_PASSWORD` },
    rocketmq: {},
    zadig: {},
  }
}

let dir: string
let envsPath: string
let matrix: Matrix
let ctx: Context
let pool: EnvProviderPool

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-env-provider-'))
  envsPath = join(dir, 'envs.yml')
  matrix = {
    [DP0]: row(DP0, 'https://dbx.dp0.example.invalid'),
    [TP0]: row(TP0, 'https://dbx.tp0.example.invalid'),
  }
  writeFileSync(envsPath, JSON.stringify(matrix))
  ctx = new Context()
  pool = new EnvProviderPool(ctx, { envsPath })
})

afterEach(async () => {
  await pool.dispose()
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('EnvProviderPool', () => {
  it('reuses one environment and isolates different environments from the root', async () => {
    const [first, concurrent] = await Promise.all([pool.acquire(DP0), pool.acquire(DP0)])
    const other = await pool.acquire(TP0)

    const firstStore = first.require('cacheStore')
    const otherStore = other.require('cacheStore')
    expect(firstStore).toBe(concurrent.cacheStore)
    expect(firstStore).not.toBe(otherStore)
    expect(firstStore.backendRef).toBe('dbx:https://dbx.dp0.example.invalid')
    expect(otherStore.backendRef).toBe('dbx:https://dbx.tp0.example.invalid')
    expect(ctx.get('cacheStore')).toBeUndefined()
    expect(ctx.get('dbStore')).toBeUndefined()

    await Promise.all([first.release(), concurrent.release(), other.release()])
  })

  it('drains an old configuration generation after its last lease releases', async () => {
    const old = await pool.acquire(DP0)
    matrix[DP0] = row(DP0, 'https://dbx.dp0-v2.example.invalid')
    writeFileSync(envsPath, JSON.stringify(matrix))

    const current = await pool.acquire(DP0)
    const currentStore = current.require('cacheStore')
    const oldStore = old.require('cacheStore')
    expect(currentStore).not.toBe(oldStore)
    expect(oldStore.backendRef).toBe('dbx:https://dbx.dp0.example.invalid')
    expect(currentStore.backendRef).toBe('dbx:https://dbx.dp0-v2.example.invalid')

    await old.release()
    await old.release()
    await current.release()
  })

  it('degrades a leg with a missing endpoint instead of rejecting the environment', async () => {
    // 池契约：环境存在于矩阵即 acquire 成功，缺配置的腿按腿降级——缺失信息
    // 出现在 unavailableLegs 与 require() 的错误里，根上下文不残留任何插槽实例。
    matrix[DP0] = { ...row(DP0, ''), dbx: { passwordRef: `DBX_${DP0}_PASSWORD` } }
    writeFileSync(envsPath, JSON.stringify(matrix))

    const lease = await pool.acquire(DP0)
    const dbx = lease.unavailableLegs.find(item => item.leg === 'dbx')
    expect(dbx?.error).toContain('endpoint')
    expect(lease.cacheStore).toBeUndefined()
    expect(() => lease.require('cacheStore')).toThrow(/cacheStore Provider 不可用/)
    expect(ctx.get('cacheStore')).toBeUndefined()

    await lease.release()
  })
})
