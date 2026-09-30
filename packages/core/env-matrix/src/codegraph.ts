/**
 * Shared codegraph index contract — the single authority for the marker
 * file name/format, worktree-aware git-dir resolution, and index
 * availability probes.
 *
 * Both consumers previously kept private copies synced only by comments
 * (tool-code-repository/src/{sync,search}.ts and the agent's clone-repos
 * bootstrap); the worktree handling had already drifted between them. This
 * module turns that comment-sync into an import. It lives in env-matrix
 * because that is the one workspace package both consumers already depend
 * on; it has no env-matrix semantics of its own.
 *
 * @module @dsh-sentry/env-matrix/codegraph
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** CodeGraph 索引目录名（见 {@link codegraphAvailable}）。 */
export const CODEGRAPH_DIR = '.codegraph'

/** 索引标记文件名（位于 git 目录内）：内容 = 建索引时的完整 HEAD sha。 */
export const CODEGRAPH_HEAD_MARKER = 'dsh-codegraph-head'

/** 是否已有 codegraph 索引：`.codegraph` 目录存在且非空。
 *  只判「目录有东西」——是否完整（init 是否跑完）用 {@link hasCompleteIndex}。 */
export function codegraphAvailable(repoPath: string): boolean {
  const dir = resolve(repoPath, CODEGRAPH_DIR)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/** 仓库的 git 目录：普通 clone 是 .git/ 目录；worktree/子模块下 .git 是内容为 `gitdir: <path>` 的文件。 */
export function gitDirOf(repoPath: string): string {
  const dotGit = resolve(repoPath, '.git')
  let isDirectory: boolean
  try {
    isDirectory = statSync(dotGit).isDirectory()
  } catch {
    // .git 缺失等 IO 错误归入同一设计错误，而不是把裸 ENOENT 泄给调用方
    throw new Error(`无法解析 .git（既非目录也非 gitdir 指针）: ${dotGit}`)
  }
  if (isDirectory) return dotGit
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
  if (match === null) throw new Error(`无法解析 .git（既非目录也非 gitdir 指针）: ${dotGit}`)
  return resolve(repoPath, match[1]!.trim())
}

/** 读取索引标记（完整 sha）；缺失/不可读返回 undefined。 */
export function readIndexMarker(repoPath: string): string | undefined {
  try {
    return readFileSync(join(gitDirOf(repoPath), CODEGRAPH_HEAD_MARKER), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** 建索引成功后写标记；IO 失败非致命（下次 sync 多重建一次，无害）。 */
export function writeIndexMarker(repoPath: string, sha: string): boolean {
  try {
    writeFileSync(join(gitDirOf(repoPath), CODEGRAPH_HEAD_MARKER), `${sha}\n`)
    return true
  } catch {
    return false
  }
}

/** bootstrap init 的「完成态」：索引目录非空 **且** marker 已落。
 *  init 中断（超时/被杀）会留下部分写入的 .codegraph 但没有 marker——旧判据
 *  （仅目录非空）会把它当已索引而永不重试；本判据让 clone-repos 重跑时重新 init。 */
export function hasCompleteIndex(repoPath: string): boolean {
  return codegraphAvailable(repoPath) && readIndexMarker(repoPath) !== undefined
}
