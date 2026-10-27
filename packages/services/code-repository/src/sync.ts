/**
 * git sync for the code-repository service: refresh the configured product
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
 * Index self-healing: every successful reindex writes the indexed
 * HEAD into `.git/dsh-codegraph-head` (the marker contract, owned by
 * @dsh-sentry/env-matrix's codegraph module — clone-repos imports it from
 * there too, so the two can no longer drift). syncRepo then
 * reindexes whenever the marker disagrees with the current HEAD, which
 * covers out-of-band drift (manual branch switches, manual pulls) even
 * when the pull itself is up-to-date or failed. The heal picks its
 * command by marker state (see healAction): a missing marker heals with a
 * full `init` (an interrupted bootstrap's partial index must not be
 * whitewashed by an incremental sync); a drifted marker heals with an
 * incremental `sync`. Index CREATION on a repo without any `.codegraph`
 * is still bootstrap-only (clone-repos' job).
 *
 * @module @dsh-sentry/service-code-repository/sync
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readIndexMarker, writeIndexMarker } from '@dsh-sentry/env-matrix'
import { codegraphAvailable, type RepoRef } from './search.ts'

const execFileAsync = promisify(execFile)

/** Hard ceiling per git invocation (pull can hit the network). */
const GIT_TIMEOUT_MS = 120_000
/** Hard ceiling for codegraph reindexing after a sync (both heal shapes).
 *  Sized for the worst case, not the common one: a marker-drift heal on a
 *  large repo (branch switch) reindexes most of it, and the marker-missing
 *  heal is a full init — the same job bootstrap gives init 600s. Timeouts
 *  are ceilings, not waits, so the common small fast-forward delta is
 *  unaffected. */
const INDEX_TIMEOUT_MS = 600_000
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
  /** Reindex outcome after an update or a marker-drift heal; absent when not attempted. */
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

// 索引标记契约（文件名/格式、worktree 感知的 git 目录解析、读写）唯一权威源在
// @dsh-sentry/env-matrix（codegraph.ts）——本包与 apps/agent 的 clone-repos 都从那里
// import，两份实现曾因此在 worktree 形态上分叉。此处 re-export 维持本包既有导入面。
export { CODEGRAPH_HEAD_MARKER, gitDirOf, readIndexMarker, writeIndexMarker } from '@dsh-sentry/env-matrix'

/** 是否需要重建索引：有索引且（本次有更新 ∨ 标记缺失 ∨ 标记与当前 HEAD 不一致）。
 *  与 pull 结果解耦——分叉/脏工作区的 error 仓库若 HEAD 已漂移同样要自愈。 */
export function needsReindex(
  status: SyncResult['status'],
  hasIndex: boolean,
  marker: string | undefined,
  currentHead: string | undefined,
): boolean {
  if (!hasIndex || currentHead === undefined) return false
  return status === 'updated' || marker === undefined || marker !== currentHead
}

/**
 * Which reindex command a heal should run. A missing marker means the index
 * may be an interrupted bootstrap's partial write — only a full `init` can
 * rebuild what the interruption missed; letting an incremental `sync`
 * succeed there would whitewash the partial index and permanently defeat
 * clone-repos' hasCompleteIndex re-init guard. A present-but-drifted marker
 * means the index is complete and merely stale — the incremental `sync` is
 * the cheap, correct refresh.
 */
export function healAction(marker: string | undefined): 'init' | 'sync' {
  return marker === undefined ? 'init' : 'sync'
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

/** Full (re)index for the marker-missing heal path: `codegraph init <path>`.
 *  Fixed argv like the git side; never throws. */
export async function runCodegraphInit(repoPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileAsync('codegraph', ['init', repoPath], {
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
 * runs on a real update OR any marker/HEAD drift — see needsReindex; its
 * outcome is recorded, never fatal. The heal picks its command via
 * {@link healAction}: marker-missing heals rebuild fully (init), drifted
 * markers refresh incrementally (sync).
 */
export async function syncRepo(repo: RepoRef): Promise<SyncResult> {
  const result = await runGitPull(repo)
  result.codegraph_index = codegraphAvailable(repo.path)
  if (!result.codegraph_index) return result

  const fullHead = await runGit(repo.path, ['rev-parse', 'HEAD'])
  const currentHead = fullHead.ok ? fullHead.stdout : undefined
  const marker = readIndexMarker(repo.path)
  if (!needsReindex(result.status, result.codegraph_index, marker, currentHead)) return result

  const index = healAction(marker) === 'init'
    ? await runCodegraphInit(repo.path)
    : await runCodegraphSync(repo.path)
  result.index_sync = index.ok ? 'ok' : 'failed'
  if (!index.ok) result.index_error = index.error
  else if (currentHead !== undefined) writeIndexMarker(repo.path, currentHead)
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

  const reindexFailed = results.filter(r => r.index_sync === 'failed')
  const reindexed = results.filter(r => r.index_sync === 'ok')
  let note = '。'
  if (reindexFailed.length > 0) {
    note = `；codegraph 索引同步失败（${reindexFailed.map(r => r.repo).join('、')}，详见 index_error），搜索无结果时会回退 ripgrep。`
  } else if (reindexed.length > 0) {
    note = `；codegraph 索引已同步（${reindexed.map(r => r.repo).join('、')}）。`
  }
  return `同步 ${results.length} 个仓库：${parts.join('、')}${note}`
}
