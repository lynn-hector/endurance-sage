/**
 * Pure helpers for the code-repository tools: repo discovery, language
 * globs, ripgrep JSON event parsing, and snippet merging.
 *
 * Port of the corresponding helpers in the original
 * `skills/code-repository/scripts/query.py` (`_iter_repos`,
 * `_apply_filter`, `_dedupe_repos`, `_LANG_GLOBS`, `_language_globs`,
 * `_run_rg_query`'s event loop, `_build_rg_snippets`, `_normalize_file`,
 * `_build_summary`), verbatim in behavior.
 *
 * @module @dsh-sentry/tool-code-repository/search
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** Context lines around a ripgrep match (`_SNIPPET_CONTEXT`). */
export const SNIPPET_CONTEXT = 2

/** One discovered repository. */
export interface RepoRef {
  name: string
  path: string
}

/** Repo discovery + search configuration (the plugin Config core). */
export interface RepoConfig {
  /** Explicit name → path map (the original `datasources.code.repos`). */
  repos?: Record<string, string>
  /** Base directory globbed with {@link repoNamePattern} (the original `base_dir`). */
  baseDir?: string
  /** Glob for {@link baseDir} children, default `novo-*`. */
  repoNamePattern?: string
  /** Single repository path (the original `repo_path`). */
  repoPath?: string
}

/** Language → file globs, the original `_LANG_GLOBS` row for row. */
export const LANG_GLOBS: Record<string, string[]> = {
  go: ['*.go'],
  python: ['*.py'],
  java: ['*.java'],
  typescript: ['*.ts'],
  javascript: ['*.js'],
  proto: ['*.proto'],
  sql: ['*.sql'],
  yaml: ['*.yml', '*.yaml'],
  json: ['*.json'],
}

/** Original `_language_globs`: known language or a `*.<lang>` fallback. */
export function languageGlobs(language?: string): string[] {
  if (!language) return []
  return LANG_GLOBS[language.toLowerCase()] ?? [`*.${language.toLowerCase()}`]
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Original `_apply_filter`: name/path/basename match, else an existing dir stands alone. */
export function applyFilter(repos: RepoRef[], repoFilter?: string): RepoRef[] {
  if (!repoFilter) return repos
  const filtered = repos.filter(
    ({ name, path }) => name === repoFilter || path === repoFilter || basename(path) === repoFilter,
  )
  if (filtered.length > 0) return filtered
  if (existsSync(repoFilter) && isDir(repoFilter)) {
    return [{ name: basename(repoFilter), path: resolve(repoFilter) }]
  }
  return []
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? path
}

/**
 * Original `_iter_repos` branches without filtering: explicit `repos` map,
 * then `baseDir` glob, then a single `repoPath`.
 */
function collectRepos(config: RepoConfig): RepoRef[] {
  let repos: RepoRef[] = []

  if (config.repos !== undefined && Object.keys(config.repos).length > 0) {
    for (const [name, raw] of Object.entries(config.repos)) {
      if (raw) repos.push({ name, path: raw })
    }
    return repos
  }

  if (config.baseDir !== undefined) {
    const pattern = config.repoNamePattern ?? 'novo-*'
    if (isDir(config.baseDir)) {
      for (const entry of readdirSync(config.baseDir).sort()) {
        if (globMatch(pattern, entry) && isDir(resolve(config.baseDir, entry))) {
          repos.push({ name: entry, path: resolve(config.baseDir, entry) })
        }
      }
    }
    return repos
  }

  if (config.repoPath !== undefined) {
    repos = [{ name: basename(config.repoPath), path: config.repoPath }]
  }
  return repos
}

/**
 * Original `_iter_repos` + `_dedupe_repos`: explicit `repos` map wins, then
 * `baseDir` glob, then a single `repoPath`; results are deduped by resolved
 * absolute path keeping the first name.
 */
export function iterRepos(config: RepoConfig, repoFilter?: string): RepoRef[] {
  return dedupeRepos(applyFilter(collectRepos(config), repoFilter))
}

/**
 * Sync-scoped variant of {@link iterRepos}: the filter only selects among
 * repos that came from Config (name / configured path / basename) and never
 * admits an arbitrary existing directory the way search's filter fallback
 * does — `git pull` may only run where the operator pointed the plugin.
 */
export function iterConfiguredRepos(config: RepoConfig, repoFilter?: string): RepoRef[] {
  const candidates = collectRepos(config)
  if (!repoFilter) return dedupeRepos(candidates)
  return dedupeRepos(
    candidates.filter(
      ({ name, path }) => name === repoFilter || path === repoFilter || basename(path) === repoFilter,
    ),
  )
}

function globMatch(pattern: string, name: string): boolean {
  // The original used Path.glob with shell-style patterns; novo-* is the
  // only pattern in practice. Support a single trailing *-suffix plus an
  // optional leading *-prefix, matching Path.glob's fnmatch semantics.
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length >= 2) {
    const middle = pattern.slice(1, -1)
    return name.includes(middle)
  }
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1))
  }
  if (pattern.startsWith('*')) {
    return name.endsWith(pattern.slice(1))
  }
  return pattern === name
}

/** Original `_dedupe_repos`: dedupe by resolved path, keep the first name. */
export function dedupeRepos(repos: RepoRef[]): RepoRef[] {
  const seen = new Set<string>()
  const result: RepoRef[] = []
  for (const repo of repos) {
    let resolved: string
    try {
      resolved = resolve(repo.path)
    } catch {
      resolved = repo.path
    }
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push({ name: repo.name, path: resolved })
  }
  return result
}

/** Original `_normalize_file`: strip `./` and make repo-relative. */
export function normalizeFile(file: string, repoPath: string): string {
  if (file.startsWith('./')) return file.slice(2)
  if (file.startsWith('/')) {
    const resolved = resolve(repoPath)
    if (file.startsWith(resolved + '/')) return file.slice(resolved.length + 1)
  }
  return file
}

/** One normalized search snippet (`{repo,file,line_start,line_end,content,score}`). */
export interface CodeSnippet {
  repo: string
  file: string
  line_start: number
  line_end: number
  content: string
  score: number
}

/**
 * One ripgrep JSON event stream per file: collected lines with match flags
 * (`_run_rg_query`'s begin/context/match/end handling).
 */
export interface RgFileEvents {
  file: string
  lines: { line: number; text: string; isMatch: boolean }[]
}

/**
 * Original `_build_rg_snippets`: drop files without matches, expand each
 * match by {@link SNIPPET_CONTEXT}, merge overlapping/adjacent ranges, and
 * join the covered lines.
 */
export function buildRgSnippets(
  repoName: string,
  repoPath: string,
  events: RgFileEvents,
): CodeSnippet[] {
  const matchLines = events.lines.filter(line => line.isMatch).map(line => line.line)
  if (matchLines.length === 0) return []

  const ranges = matchLines
    .map(m => [Math.max(1, m - SNIPPET_CONTEXT), m + SNIPPET_CONTEXT] as const)
    .sort((a, b) => a[0] - b[0])

  const merged: [number, number][] = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && start <= last[1] + 1) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], end)]
    } else {
      merged.push([start, end])
    }
  }

  const lineText = new Map(events.lines.map(line => [line.line, line.text]))
  return merged.map(([start, end]) => {
    const texts: string[] = []
    for (let ln = start; ln <= end; ln++) {
      texts.push((lineText.get(ln) ?? '').replace(/\r?\n$/, ''))
    }
    return {
      repo: repoName,
      file: normalizeFile(events.file, repoPath),
      line_start: start,
      line_end: end,
      content: texts.join('\n'),
      score: 0.0,
    }
  })
}

/** Original `_build_summary`. */
export function buildSearchSummary(results: CodeSnippet[], query: string, repoCount: number): string {
  if (results.length === 0) {
    return `在 ${repoCount} 个仓库中未找到与 '${query}' 相关的代码。`
  }
  const repoNames = [...new Set(results.map(r => r.repo))].sort()
  return `在 ${repoCount} 个仓库中搜索 '${query}'，返回 ${results.length} 处结果，涉及仓库：${repoNames.join(', ')}。`
}

/** CodeGraph index directory marker (see {@link codegraphAvailable}). */
export const CODEGRAPH_DIR = '.codegraph'

/** Original `_codegraph_available`: the index directory exists and is non-empty. */
export function codegraphAvailable(repoPath: string): boolean {
  const dir = resolve(repoPath, CODEGRAPH_DIR)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}
