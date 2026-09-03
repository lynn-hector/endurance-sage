import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { iterConfiguredRepos, iterRepos, codegraphAvailable, CODEGRAPH_DIR } from '../src/search.ts'
import { buildSyncSummary, inspectRepo, runGitPull, syncRepo } from '../src/sync.ts'

/**
 * Sync tests against a REAL git fixture: one bare origin, one working clone
 * (the sync target) and one helper clone (pushes remote commits). Covers
 * the fast-forward / up-to-date / diverged / not-a-repo paths plus the
 * narrow repo-discovery boundary that separates sync from search. The
 * codegraph reindex path runs against the real codegraph binary when it is
 * on PATH, and is skipped otherwise.
 */

const hasCodegraph = (() => {
  try {
    execFileSync('codegraph', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

let base: string
let origin: string
let work: string
let helper: string
let plainDir: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function head(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd }).toString().trim()
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.email=sentry@test', '-c', 'user.name=sentry', 'commit', '-m', message)
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-code-sync-'))

  const seed = join(base, 'seed')
  git(base, 'init', '-b', 'main', 'seed')
  commitFile(seed, 'a.txt', 'one\n', 'init')

  origin = join(base, 'origin.git')
  git(base, 'clone', '--bare', 'seed', 'origin.git')

  work = join(base, 'novo-demo')
  git(base, 'clone', 'origin.git', 'novo-demo')

  helper = join(base, 'helper')
  git(base, 'clone', 'origin.git', 'helper')

  plainDir = join(base, 'plain')
  mkdirSync(plainDir)
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('runGitPull (real git)', () => {
  it('reports up_to_date when origin has nothing new', async () => {
    const result = await runGitPull({ name: 'novo-demo', path: work })
    expect(result.status).toBe('up_to_date')
    expect(result.head_before).toBe(head(work))
    expect(result.head_after).toBe(result.head_before)
    expect(result.branch).toBe('main')
    expect(result.error).toBeUndefined()
  })

  it('fast-forwards to a pushed remote commit, then reports up_to_date again', async () => {
    commitFile(helper, 'b.txt', 'two\n', 'second')
    git(helper, 'push', 'origin', 'main')

    const before = head(work)
    const updated = await runGitPull({ name: 'novo-demo', path: work })
    expect(updated.status).toBe('updated')
    expect(updated.head_before).toBe(before)
    expect(updated.head_after).toBe(head(origin))
    expect(updated.head_after).not.toBe(updated.head_before)
    expect(updated.detail).toContain('Fast-forward')

    const again = await runGitPull({ name: 'novo-demo', path: work })
    expect(again.status).toBe('up_to_date')
  })

  it('refuses a diverged repo (ff-only) and keeps HEAD untouched', async () => {
    commitFile(work, 'local.txt', 'local\n', 'local-divergence') // unpushed local commit
    commitFile(helper, 'remote.txt', 'remote\n', 'remote-divergence')
    git(helper, 'push', 'origin', 'main')

    const before = head(work)
    const diverged = await runGitPull({ name: 'novo-demo', path: work })
    expect(diverged.status).toBe('error')
    expect(diverged.head_before).toBe(before)
    expect(diverged.error).toMatch(/fast-forward/i)
    // nothing was reset or dropped
    expect(head(work)).toBe(before)
    expect(() => execFileSync('git', ['cat-file', '-e', 'HEAD:local.txt'], { cwd: work })).not.toThrow()
  })

  it('errors on a directory that is not a git repository', async () => {
    const result = await runGitPull({ name: 'plain', path: plainDir })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/not a git repository|无法读取 HEAD/i)
  })
})

describe('inspectRepo (dry run)', () => {
  it('reports branch/HEAD without pulling', async () => {
    const peek = await inspectRepo({ name: 'novo-demo', path: work })
    expect(peek.status).toBe('dry_run')
    expect(peek.branch).toBe('main')
    expect(peek.head_before).toBe(head(work))
    expect(peek.head_after).toBeUndefined()
    expect(peek.error).toBeUndefined()
  })
})

describe('syncRepo (pull + reindex composition)', () => {
  it('skips the reindex on up_to_date and on repos without an index', async () => {
    const plain = join(base, 'novo-noindex')
    git(base, 'clone', 'origin.git', 'novo-noindex')

    const result = await syncRepo({ name: 'novo-noindex', path: plain })
    expect(result.status).toBe('up_to_date')
    expect(result.codegraph_index).toBe(false)
    expect(result.index_sync).toBeUndefined()

    // update without an index: pull succeeds, still no reindex
    commitFile(helper, 'c.txt', 'three\n', 'third')
    git(helper, 'push', 'origin', 'main')
    const updated = await syncRepo({ name: 'novo-noindex', path: plain })
    expect(updated.status).toBe('updated')
    expect(updated.index_sync).toBeUndefined()
  })
})

describe.skipIf(!hasCodegraph)('codegraph reindex (real binary)', () => {
  it('incrementally reindexes after a fast-forward update', async () => {
    const indexed = join(base, 'novo-indexed')
    git(base, 'clone', 'origin.git', 'novo-indexed')
    writeFileSync(join(indexed, 'svc.go'), 'package main\n\nfunc Serve() int { return 1 }\n')
    execFileSync('codegraph', ['init', indexed], { stdio: 'pipe' })
    expect(codegraphAvailable(indexed)).toBe(true)

    commitFile(helper, 'd.go', 'package helper\n\nfunc Bump() int { return 2 }\n', 'fourth')
    git(helper, 'push', 'origin', 'main')

    const result = await syncRepo({ name: 'novo-indexed', path: indexed })
    expect(result.status).toBe('updated')
    expect(result.codegraph_index).toBe(true)
    expect(result.index_sync).toBe('ok')
    expect(result.index_error).toBeUndefined()
    expect(result.head_after).toBe(head(origin))

    // up_to_date again: the reindex is skipped, index_sync stays absent
    const again = await syncRepo({ name: 'novo-indexed', path: indexed })
    expect(again.status).toBe('up_to_date')
    expect(again.index_sync).toBeUndefined()
  }, 120_000)
})

describe('sync repo discovery (iterConfiguredRepos)', () => {
  it('selects configured repos by name/path/basename like search', () => {
    expect(iterConfiguredRepos({ repos: { demo: work } }, 'demo')).toEqual([
      { name: 'demo', path: resolve(work) },
    ])
    expect(iterConfiguredRepos({ repos: { demo: work } })).toEqual([
      { name: 'demo', path: resolve(work) },
    ])
  })

  it('never admits an arbitrary existing directory (contrast: iterRepos does)', () => {
    expect(iterConfiguredRepos({ baseDir: base }, plainDir)).toEqual([])
    expect(iterRepos({ baseDir: base }, plainDir)).toEqual([
      { name: 'plain', path: resolve(plainDir) },
    ])
  })

  it('unmatched filter yields nothing', () => {
    expect(iterConfiguredRepos({ repos: { demo: work } }, 'nope')).toEqual([])
  })
})

describe('codegraph index marker', () => {
  it('detects a non-empty .codegraph directory', () => {
    expect(codegraphAvailable(work)).toBe(false)
    mkdirSync(join(work, CODEGRAPH_DIR))
    expect(codegraphAvailable(work)).toBe(false) // present but empty
    writeFileSync(join(work, CODEGRAPH_DIR, 'index.bin'), 'x')
    expect(codegraphAvailable(work)).toBe(true)
  })
})

describe('buildSyncSummary', () => {
  it('empty results', () => {
    expect(buildSyncSummary([])).toBe('没有可同步的仓库。')
  })

  it('all up to date', () => {
    expect(
      buildSyncSummary([{ repo: 'a', path: '/a', status: 'up_to_date', head_before: 'x', head_after: 'x' }]),
    ).toBe('同步 1 个仓库：1 个已是最新。')
  })

  it('mixed outcomes name updated and failed repos', () => {
    expect(
      buildSyncSummary([
        { repo: 'a', path: '/a', status: 'updated', head_before: '1111111', head_after: '2222222' },
        { repo: 'b', path: '/b', status: 'error', error: 'boom' },
      ]),
    ).toBe('同步 2 个仓库：1 个已更新（a: 1111111→2222222）、1 个失败（b，详见 error）。')
  })

  it('reports reindex outcomes after an update', () => {
    const ok = buildSyncSummary([
      { repo: 'a', path: '/a', status: 'updated', head_before: '1', head_after: '2', codegraph_index: true, index_sync: 'ok' },
    ])
    expect(ok).toContain('codegraph 索引已随更新同步（a）')

    const fail = buildSyncSummary([
      { repo: 'a', path: '/a', status: 'updated', head_before: '1', head_after: '2', codegraph_index: true, index_sync: 'failed', index_error: 'boom' },
    ])
    expect(fail).toContain('codegraph 索引同步失败（a')
    expect(fail).toContain('回退 ripgrep')

    // updated repo without an index: no reindex, no note
    expect(
      buildSyncSummary([{ repo: 'a', path: '/a', status: 'updated', head_before: '1', head_after: '2', codegraph_index: false }]),
    ).toBe('同步 1 个仓库：1 个已更新（a: 1→2）。')
  })
})
