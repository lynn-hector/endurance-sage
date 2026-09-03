/**
 * git sync for the code-repository tool: refresh the configured product
 * repositories with `git pull --ff-only`.
 *
 * Why this tool may run git at all — and why it is safe even though
 * git-guard never sees it: git-guard intercepts the bash tool's command
 * STRING inside the DSH tool pipeline; this tool execs in the host process
 * like every other sentry service, outside that pipeline. The guard rails
 * are therefore intrinsic to the tool:
 * - fixed argv — exactly `git pull --ff-only` (plus read-only `rev-parse`);
 *   the model picks WHICH configured repository, never the command or its
 *   flags. No shell string, nothing to inject, nothing to smuggle past a
 *   pattern.
 * - `--ff-only` — refuses to create merge commits and refuses when local
 *   history diverged: it can fast-forward or fail, so it never rewrites
 *   history and never discards local work (the same red lines git-guard
 *   enforces on bash).
 * - configured repos only — iterConfiguredRepos admits no arbitrary path,
 *   unlike search whose filter may stand an ad-hoc directory alone.
 * - bounded — sequential per-repo execution, hard timeout, tail-capped
 *   output in evidence.
 *
 * "updated vs up_to_date" is decided by comparing HEAD before/after, never
 * by parsing git's (locale-dependent) messages. After a real update on a
 * repo carrying a `.codegraph/` index, {@link syncRepo} runs an incremental
 * `codegraph sync --quiet` so search evidence stays fresh — the reindex is
 * recorded (`index_sync`) and its failure never fails the pull.
 *
 * @module @dsh-sentry/tool-code-repository/sync
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { codegraphAvailable, type RepoRef } from './search.ts'

const execFileAsync = promisify(execFile)

/** Hard ceiling per git invocation (pull can hit the network). */
const GIT_TIMEOUT_MS = 120_000
/** Hard ceiling for the incremental codegraph reindex after an update. */
const INDEX_TIMEOUT_MS = 180_000
/** Cap on git output kept in evidence (characters, tail-kept). */
const DETAIL_LIMIT = 2000

/** Per-repository sync outcome. */
export interface SyncResult {
  repo: string
  path: string
  /** Outcome; `dry_run` only appears via {@link inspectRepo}. */
  status: 'updated' | 'up_to_date' | 'error' | 'dry_run'
  /** Branch at sync time (`HEAD` when detached). */
  branch?: string
  /** HEAD before the pull (short sha); present once rev-parse succeeded. */
  head_before?: string
  /** HEAD after a successful pull (short sha). */
  head_after?: string
  /** Tail of git's own output on success (fast-forward stats etc.). */
  detail?: string
  /** Combined git error output on failure. */
  error?: string
  /** Whether the repo carries a .codegraph index. */
  codegraph_index?: boolean
  /** Incremental reindex outcome after an update; absent when not attempted. */
  index_sync?: 'ok' | 'failed'
  /** codegraph sync's error output when the reindex failed. */
  index_error?: string
}

/** Keep at most `limit` characters, tail-anchored, ellipsis-prefixed when cut. */
function tail(text: string, limit = DETAIL_LIMIT): string {
  const clean = text.trim()
  return clean.length <= limit ? clean : `…${clean.slice(clean.length - limit)}`
}

/** One fixed-argv git invocation; never throws. */
async function runGit(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trim() }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const parts = [err.stderr, err.stdout, err.message]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map(part => part.trim())
    return { ok: false, error: tail(parts.join('\n')) }
  }
}

/** Shared prelude: current HEAD (short sha) and branch name, error-form on failure. */
async function readHead(repo: RepoRef): Promise<SyncResult> {
  const head = await runGit(repo.path, ['rev-parse', '--short', 'HEAD'])
  if (!head.ok) {
    return { repo: repo.name, path: repo.path, status: 'error', error: `无法读取 HEAD（不是 git 仓库或没有任何提交）: ${head.error}` }
  }
  const branch = await runGit(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return {
    repo: repo.name,
    path: repo.path,
    status: 'error',
    head_before: head.stdout,
    ...(branch.ok ? { branch: branch.stdout } : {}),
  }
}

/**
 * Fast-forward one repository: `git pull --ff-only`. A diverged or dirty
 * repository fails with its own git error surfaced in `error` — nothing is
 * merged, reset, or discarded.
 */
export async function runGitPull(repo: RepoRef): Promise<SyncResult> {
  const started = await readHead(repo)
  if (started.head_before === undefined) return started

  const pull = await runGit(repo.path, ['pull', '--ff-only'])
  if (!pull.ok) {
    return { ...started, error: `git pull --ff-only 失败（本地分叉或工作区不干净时不强行同步）: ${pull.error}` }
  }

  const after = await runGit(repo.path, ['rev-parse', '--short', 'HEAD'])
  const headAfter = after.ok ? after.stdout : undefined
  return {
    ...started,
    status: headAfter !== undefined && headAfter === started.head_before ? 'up_to_date' : 'updated',
    ...(headAfter !== undefined ? { head_after: headAfter } : {}),
    ...(pull.stdout.length > 0 ? { detail: tail(pull.stdout) } : {}),
  }
}

/** Dry-run inspection: current branch/HEAD per repo, no pull, no network. */
export async function inspectRepo(repo: RepoRef): Promise<SyncResult> {
  const peeked = await readHead(repo)
  return peeked.head_before === undefined ? peeked : { ...peeked, status: 'dry_run' }
}

/**
 * Incremental codegraph reindex after a fast-forward: `codegraph sync
 * --quiet <path>`. Fixed argv like the git side; never throws. Failure here
 * must NOT fail the pull result — it degrades search to the ripgrep
 * fallback until someone re-indexes.
 */
export async function runCodegraphSync(repoPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileAsync('codegraph', ['sync', '--quiet', repoPath], {
      cwd: repoPath,
      timeout: INDEX_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true }
  } catch (error) {
    const err = error as { stderr?: string; message?: string }
    const parts = [err.stderr, err.message]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map(part => part.trim())
    return { ok: false, error: tail(parts.join('\n')) }
  }
}

/**
 * Pull one repo, then refresh its codegraph index when present. The reindex
 * only runs on a real update — `up_to_date` means the tree did not change —
 * and its outcome is recorded, never fatal.
 */
export async function syncRepo(repo: RepoRef): Promise<SyncResult> {
  const result = await runGitPull(repo)
  result.codegraph_index = codegraphAvailable(repo.path)
  if (result.status === 'updated' && result.codegraph_index) {
    const index = await runCodegraphSync(repo.path)
    result.index_sync = index.ok ? 'ok' : 'failed'
    if (!index.ok) result.index_error = index.error
  }
  return result
}

/** One-sentence summary per the evidence contract; reports reindex outcomes. */
export function buildSyncSummary(results: SyncResult[]): string {
  if (results.length === 0) return '没有可同步的仓库。'

  const updated = results.filter(r => r.status === 'updated')
  const upToDate = results.filter(r => r.status === 'up_to_date')
  const failed = results.filter(r => r.status === 'error')

  const parts: string[] = []
  if (updated.length > 0) {
    parts.push(`${updated.length} 个已更新（${updated.map(r => `${r.repo}: ${r.head_before}→${r.head_after}`).join('、')}）`)
  }
  if (upToDate.length > 0) parts.push(`${upToDate.length} 个已是最新`)
  if (failed.length > 0) parts.push(`${failed.length} 个失败（${failed.map(r => r.repo).join('、')}，详见 error）`)

  const reindexFailed = updated.filter(r => r.index_sync === 'failed')
  const reindexed = updated.filter(r => r.index_sync === 'ok')
  let note = '。'
  if (reindexFailed.length > 0) {
    note = `；codegraph 索引同步失败（${reindexFailed.map(r => r.repo).join('、')}，详见 index_error），搜索无结果时会回退 ripgrep。`
  } else if (reindexed.length > 0) {
    note = `；codegraph 索引已随更新同步（${reindexed.map(r => r.repo).join('、')}）。`
  }
  return `同步 ${results.length} 个仓库：${parts.join('、')}${note}`
}
