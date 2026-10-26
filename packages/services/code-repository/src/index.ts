/**
 * Local code-repository access as a Cordis service — the code-evidence
 * leg's Provider half, occupying the named `ctx.codeRepository` slot.
 *
 * The transport here is NOT HTTP but the host process itself: fixed-argv
 * subprocesses (`codegraph query --json`, `rg --json`, `git pull
 * --ff-only`, `codegraph sync|init`) plus bounded file reads, exactly like
 * every sibling service execs HTTP. The subprocess surface is read-only
 * except sync, whose guardrails are intrinsic (fixed argv, --ff-only,
 * configured repos only — see ./sync.ts).
 *
 * Repo discovery (repos map / baseDir glob / repoPath) is service Config,
 * so the tool layer holds only schemas and evidence envelopes. The pure
 * vocabulary (discovery, rg event parsing, snippet merging, sync results
 * and their summary wording) lives in ./search.ts and ./sync.ts with their
 * golden tests; the summary builders are re-exported for the Consumer the
 * way the reference seam convention allows for named domain services.
 *
 * Deliberate deviation from the reference structure this package follows:
 * the codegraph gate uses the COMPLETE-state contract (`hasCompleteIndex`:
 * index dir non-empty AND the HEAD marker written) instead of the weaker
 * `codegraphAvailable` — an interrupted bootstrap leaves a partial index
 * that would miss real matches with high confidence (a non-empty result
 * would keep the rg fallback from ever firing), so ripgrep is preferred
 * over a残缺 index. The marker contract itself is owned by
 * @dsh-sentry/env-matrix (codegraph.ts), shared with the clone-repos
 * bootstrap.
 *
 * @module @dsh-sentry/service-code-repository
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { hasCompleteIndex } from '@dsh-sentry/env-matrix'
import {
  buildRgSnippets,
  codegraphAvailable,
  iterConfiguredRepos,
  iterRepos,
  languageGlobs,
  type CodeSnippet,
  type RepoRef,
} from './search.ts'
import { inspectRepo, syncRepo, type SyncResult } from './sync.ts'

/** One discovered repository; one normalized search snippet; one sync outcome. */
export type { CodeSnippet, RepoRef, RgFileEvents } from './search.ts'
export type { SyncResult } from './sync.ts'
/** Evidence summary wording shared with the tool Consumer. */
export { buildSearchSummary } from './search.ts'
export { buildSyncSummary } from './sync.ts'

/** Plugin configuration: the repo discovery sources (the former tool Config core). */
export type Config = import('./search.ts').RepoConfig

const execFileAsync = promisify(execFile)

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function firstInt(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

/** Bounded ±2-line read for codegraph results lacking inline content. */
async function readSnippet(
  repoPath: string,
  file: string,
  line: number,
): Promise<{ content: string; lineStart: number; lineEnd: number }> {
  try {
    const text = await readFile(resolve(repoPath, file), 'utf8')
    const lines = text.split('\n')
    const start = Math.max(1, line - 2)
    const end = Math.min(lines.length, line + 2)
    return {
      content: lines.slice(start - 1, end).join('\n').replace(/\s+$/, ''),
      lineStart: start,
      lineEnd: end,
    }
  } catch {
    return { content: '', lineStart: line, lineEnd: line }
  }
}

/** Original `_run_codegraph_query`: `codegraph query --json`, failures fall back to []. */
async function runCodegraphQuery(
  repo: RepoRef,
  query: string,
  limit: number,
): Promise<CodeSnippet[]> {
  let stdout: string
  try {
    const result = await execFileAsync(
      'codegraph',
      ['query', '--json', '--limit', String(limit), query],
      { cwd: repo.path, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    )
    stdout = result.stdout
  } catch {
    return []
  }

  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }

  const results = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['results'])
      ? ((data as Record<string, unknown>)['results'] as unknown[])
      : []
  if (!Array.isArray(results)) return []

  const out: CodeSnippet[] = []
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const file = firstString(record, ['file', 'path', 'file_path', 'location'])
    const line = firstInt(record, ['line', 'line_number', 'lnum', 'line_start'])
    if (file === undefined || line === undefined) continue

    let content = firstString(record, ['content', 'snippet', 'text', 'source'])
    let lineStart = firstInt(record, ['line_start']) ?? line
    let lineEnd = firstInt(record, ['line_end']) ?? line
    if (content === undefined) {
      const read = await readSnippet(repo.path, file, line)
      content = read.content
      lineStart = read.lineStart
      lineEnd = read.lineEnd
    }

    let score = 0.0
    const rawScore = firstString(record, ['score', 'relevance', 'rank'])
    if (rawScore !== undefined) {
      const parsed = Number(rawScore)
      if (Number.isFinite(parsed)) score = parsed
    }

    out.push({
      repo: repo.name,
      file: file.startsWith('/') ? file.slice(resolve(repo.path).length + 1) : file,
      line_start: lineStart,
      line_end: lineEnd,
      content: content ?? '',
      score,
    })
  }
  return out
}

/** Original `_run_rg_query`: ripgrep fixed-string search with JSON events. */
export async function runRgQuery(
  repo: RepoRef,
  query: string,
  limit: number,
  language?: string,
): Promise<CodeSnippet[]> {
  const args = ['-F', '-i', '-C', '2', '-m', String(limit), '--json', '--no-binary']
  for (const glob of languageGlobs(language)) {
    args.push('-g', glob)
  }
  args.push('--', query, '.')

  let stdout: string
  try {
    const result = await execFileAsync('rg', args, {
      cwd: repo.path,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch {
    // rg exits 1 on no matches and 2 on errors; both mean "no snippets".
    return []
  }

  const snippets: CodeSnippet[] = []
  let currentFile: string | undefined
  let currentLines: { line: number; text: string; isMatch: boolean }[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0) continue
    let message: { type?: string; data?: Record<string, unknown> }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      continue
    }
    const event = message.data
    if (message.type === 'begin') {
      currentFile = typeof event?.['path'] === 'object' && event['path'] !== null
        ? String((event['path'] as Record<string, unknown>)['text'] ?? '')
        : undefined
      currentLines = []
    } else if (message.type === 'context' || message.type === 'match') {
      const lineNo = event?.['line_number']
      const text = typeof event?.['lines'] === 'object' && event['lines'] !== null
        ? String((event['lines'] as Record<string, unknown>)['text'] ?? '')
        : ''
      if (typeof lineNo === 'number') {
        currentLines.push({ line: lineNo, text, isMatch: message.type === 'match' })
      }
    } else if (message.type === 'end') {
      if (currentFile !== undefined) {
        snippets.push(
          ...buildRgSnippets(repo.name, repo.path, { file: currentFile, lines: currentLines }),
        )
      }
      currentFile = undefined
      currentLines = []
    }
  }
  return snippets
}

/**
 * Code repository service: discovery + search + read + sync over the
 * configured product repositories. Stateless beyond Config — every call
 * resolves repositories live so an operator can add checkouts without
 * reloading.
 */
export class CodeRepositoryService extends Service {
  static Config: z<Config> = z.object({
    repos: z.dict(z.string()).description('仓库名 → 路径映射（原 datasources.code.repos）'),
    baseDir: z.string().description('仓库根目录，配合 repoNamePattern 通配（原 base_dir）'),
    repoNamePattern: z.string().default('novo-*').description('baseDir 下的仓库目录通配符，默认 novo-*'),
    repoPath: z.string().description('单一仓库路径（原 repo_path）'),
  })

  private readonly config: Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'codeRepository')
    this.config = config
  }

  /**
   * Search-scoped discovery (original `_iter_repos` semantics): the filter
   * may stand an arbitrary existing directory alone; non-existing paths are
   * dropped.
   */
  discoverRepos(repoFilter?: string): RepoRef[] {
    return iterRepos(this.config, repoFilter).filter(repo => existsSync(repo.path))
  }

  /**
   * Sync-scoped discovery: the filter only selects among repos that came
   * from Config — `git pull` may only run where the operator pointed the
   * assembly. Existing-ness is left to the caller (an unconfigured vs
   * configured-but-missing repo are different evidence).
   */
  configuredRepos(repoFilter?: string): RepoRef[] {
    return iterConfiguredRepos(this.config, repoFilter)
  }

  /**
   * Cross-repo search over the discovered repositories: CodeGraph index
   * when complete, ripgrep fallback per repo; results sorted by score then
   * location, capped to `limit`.
   */
  async searchCode(
    query: string,
    options: { repo?: string; language?: string; limit?: number } = {},
  ): Promise<CodeSnippet[]> {
    const limit = options.limit ?? 20
    const repos = this.discoverRepos(options.repo)
    const all: CodeSnippet[] = []
    for (const repo of repos) {
      // 闸门用「完成态」而非「目录非空」：中断 init 留下的部分索引会以高置信度漏掉
      // 真实匹配（结果非空则 rg fallback 永不触发），宁可走 ripgrep 也不用残缺索引
      const indexed = hasCompleteIndex(repo.path)
        ? await runCodegraphQuery(repo, query, limit)
        : []
      all.push(...(indexed.length > 0 ? indexed : await runRgQuery(repo, query, limit, options.language)))
    }
    return all
      .sort((a, b) =>
        b.score - a.score
        || a.repo.localeCompare(b.repo)
        || a.file.localeCompare(b.file)
        || a.line_start - b.line_start,
      )
      .slice(0, limit)
  }

  /**
   * Read one file from a discovered repository. Returns the raw text plus
   * the resolved repo; line numbering and range slicing are the caller's
   * (envelope) concern. `undefined` when the repo is not discovered.
   */
  async readCodeFile(
    repoFilter: string,
    file: string,
  ): Promise<{ repo: RepoRef; content: string } | undefined> {
    const repo = this.discoverRepos(repoFilter)[0]
    if (repo === undefined) return undefined
    const content = await readFile(resolve(repo.path, file), 'utf8')
    return { repo, content }
  }

  /**
   * Inspect (dry-run) or fast-forward one repo; always fills the
   * `codegraph_index` flag so the envelope reports index presence uniformly.
   */
  async syncOne(repo: RepoRef, dryRun: boolean): Promise<SyncResult> {
    const result = dryRun ? await inspectRepo(repo) : await syncRepo(repo)
    if (result.codegraph_index === undefined) {
      result.codegraph_index = codegraphAvailable(repo.path)
    }
    return result
  }
}

export default CodeRepositoryService

declare module '@deepseek-ai/cordis' {
  interface Context {
    codeRepository: CodeRepositoryService
  }
}
