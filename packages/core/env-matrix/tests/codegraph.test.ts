import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CODEGRAPH_DIR,
  CODEGRAPH_HEAD_MARKER,
  codegraphAvailable,
  gitDirOf,
  hasCompleteIndex,
  readIndexMarker,
  writeIndexMarker,
} from '../src/codegraph.ts'

/** 真实 git fixture：覆盖普通 clone 与 worktree（.git 为 gitdir 指针文件）两种形态。 */
const tmp = mkdtempSync(join(tmpdir(), 'dsh-codegraph-contract-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

function makeRepo(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

/** 普通 clone：.git 是目录。 */
const plain = makeRepo('plain')
/** worktree：.git 是内容为 `gitdir: <path>` 的文件——clone-repos 旧复刻版在此 ENOTDIR。 */
const worktree = join(tmp, 'worktree')
git(plain, 'worktree', 'add', '-q', '-b', 'wt', worktree)

describe('gitDirOf', () => {
  it('普通 clone 返回 .git 目录本身', () => {
    expect(gitDirOf(plain)).toBe(join(plain, '.git'))
  })

  it('worktree（.git 为指针文件）解析到真实 git 目录（回归：旧 clone-repos 复刻版写 marker 直接 ENOTDIR）', () => {
    const dotGit = join(worktree, '.git')
    expect(existsSync(dotGit)).toBe(true) // .git 存在
    const resolved = gitDirOf(worktree)
    expect(resolved).not.toBe(dotGit) // 且不是那个文件本身
    expect(existsSync(resolved)).toBe(true)
  })

  it('.git 既非目录也非合法指针时抛错', () => {
    const junk = join(tmp, 'gitdir-junk')
    mkdirSync(junk)
    writeFileSync(join(junk, '.git'), 'not a pointer')
    expect(() => gitDirOf(junk)).toThrow(/无法解析/)
  })

  it('.git 缺失（最常见的畸形输入）也抛设计错误信息，而非裸 ENOENT', () => {
    const bare = join(tmp, 'gitdir-missing')
    mkdirSync(bare)
    expect(() => gitDirOf(bare)).toThrow(/无法解析/)
  })
})

describe('codegraphAvailable', () => {
  it('无目录/空目录 false，非空 true', () => {
    expect(codegraphAvailable(plain)).toBe(false)
    mkdirSync(join(plain, CODEGRAPH_DIR))
    expect(codegraphAvailable(plain)).toBe(false) // 存在但空
    writeFileSync(join(plain, CODEGRAPH_DIR, 'index.bin'), 'x')
    expect(codegraphAvailable(plain)).toBe(true)
  })
})

describe('marker 读写（含 worktree 形态）', () => {
  it('普通 clone：write 后 read round-trip，内容为完整 sha', () => {
    expect(writeIndexMarker(plain, 'a'.repeat(40))).toBe(true)
    expect(readIndexMarker(plain)).toBe('a'.repeat(40))
    expect(readFileSync(join(plain, '.git', CODEGRAPH_HEAD_MARKER), 'utf8').trim()).toBe('a'.repeat(40))
  })

  it('worktree：marker 落进解析出的 git 目录而非 .git 文件（回归 #4）', () => {
    expect(writeIndexMarker(worktree, 'b'.repeat(40))).toBe(true)
    expect(readIndexMarker(worktree)).toBe('b'.repeat(40))
    expect(existsSync(join(gitDirOf(worktree), CODEGRAPH_HEAD_MARKER))).toBe(true)
  })

  it('marker 缺失时 read 返回 undefined；非 git 目录 write 返回 false 不抛', () => {
    const noMarker = makeRepo('no-marker')
    expect(readIndexMarker(noMarker)).toBeUndefined()
    const junk = join(tmp, 'marker-junk')
    mkdirSync(junk)
    expect(writeIndexMarker(junk, 'c'.repeat(40))).toBe(false)
  })
})

describe('hasCompleteIndex（bootstrap init 完成态）', () => {
  it('无索引目录 → false', () => {
    expect(hasCompleteIndex(makeRepo('hci-none'))).toBe(false)
  })

  it('索引目录非空但 marker 缺失（init 中断的部分写入）→ false，bootstrap 据此重新 init', () => {
    const repo = makeRepo('hci-partial')
    mkdirSync(join(repo, CODEGRAPH_DIR))
    writeFileSync(join(repo, CODEGRAPH_DIR, 'index.bin'), 'partial')
    expect(codegraphAvailable(repo)).toBe(true) // 旧判据会认为「有索引」
    expect(hasCompleteIndex(repo)).toBe(false)
  })

  it('索引非空且 marker 在 → true', () => {
    const repo = makeRepo('hci-full')
    mkdirSync(join(repo, CODEGRAPH_DIR))
    writeFileSync(join(repo, CODEGRAPH_DIR, 'index.bin'), 'x')
    writeIndexMarker(repo, 'd'.repeat(40))
    expect(hasCompleteIndex(repo)).toBe(true)
  })
})
