import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAuthFailure, isCompleteClone, parseArgs, REPOS, recoverPartialClone, repoUrl, spawnClone } from '../src/clone-repos.ts'

describe('REPOS 权威清单', () => {
  it('无重复、全部 novo- 前缀（novo-* 通配可全覆盖）', () => {
    expect(REPOS).toHaveLength(28)
    expect(new Set(REPOS).size).toBe(REPOS.length)
    for (const repo of REPOS) expect(repo.startsWith('novo-'), repo).toBe(true)
  })
})

describe('repoUrl', () => {
  it('默认 HTTPS 形态', () => {
    expect(repoUrl('novo-gateway', false))
      .toBe('https://gitlab.yeastar.com/yeastar/novoone/backend/novo-gateway.git')
  })

  it('--ssh 切换 SSH 形态', () => {
    expect(repoUrl('novo-gateway', true))
      .toBe('git@gitlab.yeastar.com:yeastar/novoone/backend/novo-gateway.git')
  })
})

describe('parseArgs', () => {
  it('默认值：depth 1、非 ssh、非 dry-run、无 target', () => {
    expect(parseArgs([])).toEqual({ target: undefined, depth: 1, ssh: false, dryRun: false })
  })

  it('解析 --target/--depth/--ssh/--dry-run', () => {
    expect(parseArgs(['--target', '/srv/novoone-backend', '--depth', '3', '--ssh', '--dry-run']))
      .toEqual({ target: '/srv/novoone-backend', depth: 3, ssh: true, dryRun: true })
  })

  it('未知参数、缺值、非正整数 depth 抛错', () => {
    expect(() => parseArgs(['--nope'])).toThrow()
    expect(() => parseArgs(['--target'])).toThrow()
    expect(() => parseArgs(['--depth', '0'])).toThrow()
    expect(() => parseArgs(['--depth', 'x'])).toThrow()
    expect(() => parseArgs(['--target', '--ssh'])).toThrow()
  })

  it('裸 -- 分隔符视为 no-op（pnpm v11 会把 -- 原样透传给脚本）', () => {
    expect(parseArgs(['--', '--dry-run', '--target', '/x']))
      .toEqual({ target: '/x', depth: 1, ssh: false, dryRun: true })
    expect(parseArgs(['--'])).toEqual({ target: undefined, depth: 1, ssh: false, dryRun: false })
  })
})

describe('isAuthFailure', () => {
  it('识别常见认证失败文案', () => {
    expect(isAuthFailure('fatal: Authentication failed for \'https://gitlab.yeastar.com/...\'')).toBe(true)
    expect(isAuthFailure("fatal: could not read Username for 'https://gitlab.yeastar.com': No such device or address")).toBe(true)
    expect(isAuthFailure('remote: HTTP Basic: Access denied')).toBe(true)
  })

  it('识别 SSH 认证失败文案（--ssh 路径也要触发 AUTH_HINT）', () => {
    expect(isAuthFailure('git@gitlab.yeastar.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.')).toBe(true)
    expect(isAuthFailure('Permission denied, please try again.')).toBe(true)
  })

  it('网络等其他错误不误报', () => {
    expect(isAuthFailure('fatal: unable to access \'https://...\': Connection timed out')).toBe(false)
    expect(isAuthFailure('')).toBe(false)
  })
})

/** 真实 git fixture：临时目录 + 本地裸源仓（spawnClone 成功路径 clone 它）。 */
const tmp = mkdtempSync(join(tmpdir(), 'dsh-clone-repos-'))
const origin = join(tmp, 'origin.git')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

function makeRepo(name: string, committed: boolean): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  git(dir, 'init', '-q')
  if (committed) {
    git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  return dir
}

describe('isCompleteClone', () => {
  it('空目录与无 .git 的非空目录不算完整 clone（旧的「非空即跳过」会静默吞掉）', () => {
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    const junk = join(tmp, 'junk')
    mkdirSync(junk)
    writeFileSync(join(junk, 'README'), 'partial download remnant')
    expect(isCompleteClone(empty)).toBe(false)
    expect(isCompleteClone(junk)).toBe(false)
  })

  it('git init 后尚未落 commit 的半成品（中断 clone 的常见残留）不算完整 clone', () => {
    expect(isCompleteClone(makeRepo('unborn', false))).toBe(false)
  })

  it('HEAD 可解析的仓库（成功 clone 的保证形态）算完整 clone', () => {
    expect(isCompleteClone(makeRepo('cloned', true))).toBe(true)
  })
})

describe('recoverPartialClone', () => {
  it('git 半成品（有 .git 但 HEAD 不可解析）被删除，重跑可重新 clone', () => {
    const unborn = makeRepo('recover-unborn', false)
    expect(recoverPartialClone(unborn)).toBe(true)
    expect(existsSync(unborn)).toBe(false)
  })

  it('完整 clone 不被误删（防御：调用方应先 skip，函数自身也要安全）', () => {
    const cloned = makeRepo('recover-cloned', true)
    expect(recoverPartialClone(cloned)).toBe(false)
    expect(existsSync(cloned)).toBe(true)
  })

  it('无 .git 的非空目录不碰——可能是用户误放的数据，交给 git clone 的「目录非空」报错大声暴露', () => {
    const junk = join(tmp, 'recover-junk')
    mkdirSync(junk)
    writeFileSync(join(junk, 'user-data'), 'not git territory')
    expect(recoverPartialClone(junk)).toBe(false)
    expect(existsSync(junk)).toBe(true)
  })

  it('不存在的目录不碰', () => {
    expect(recoverPartialClone(join(tmp, 'no-such-dir'))).toBe(false)
  })
})

describe('spawnClone', () => {
  beforeAll(() => {
    // 源仓必须至少有一个 commit：克隆空仓虽 ok=true 但 HEAD unborn，不构成「完整 clone」
    const src = makeRepo('origin-src', true)
    execFileSync('git', ['clone', '-q', '--bare', src, origin])
  })

  it('成功 clone：ok=true 且目标成为完整 clone', async () => {
    const dir = join(tmp, 'spawn-ok')
    const result = await spawnClone(origin, dir, 1)
    expect(result.ok).toBe(true)
    expect(isCompleteClone(dir)).toBe(true)
  })

  it('失败 clone：ok=false 且 reason 带 git 的报错行', async () => {
    const dir = join(tmp, 'spawn-fail')
    const result = await spawnClone(join(tmp, 'no-such-origin'), dir, 1)
    expect(result.ok).toBe(false)
    expect(result.reason.length).toBeGreaterThan(0)
  })
})
