/**
 * Code repository tools: cross-repo code search and file reading.
 *
 * Port of the original `skills/code-repository` (SKILL.md +
 * scripts/query.py) as ONE package — unlike the inspector skills there is
 * no credential/session transport to factor into a service, so the
 * search engines (CodeGraph index preferred, ripgrep fallback) and the
 * repo discovery live here, next to the tools.
 *
 * Why a tool at all, when the agent runtime has native file tools: the
 * session sandbox confines those to the session workspace, while the
 * product repositories live elsewhere on disk. Executing through the
 * harness process (like every sentry service does for HTTP) gives the
 * model controlled READ-ONLY visibility into the code: the subprocess
 * surface is `rg` and file reads, nothing else.
 *
 * Deliberate deviations from the script era (recorded):
 * - `sentry_read_code` is NEW: the SKILL.md promised "读取指定文件或文件
 *   片段" but query.py had no such capability. The gap is closed here.
 * - Output uses the standard `{ evidence: ... }` envelope (the script
 *   printed bare `{query, results, summary}`, drifting from the project's
 *   own evidence contract; recorded drift like the other skills).
 * - `--env` disappeared: repo discovery moved from `config/{env}.yml`
 *   `datasources.code` into this plugin's Config.
 *
 * @module @dsh-sentry/tool-code-repository
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import {
  buildRgSnippets,
  buildSearchSummary,
  languageGlobs,
  iterRepos,
  type CodeSnippet,
  type RepoRef,
} from './search.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-code-repository'

/** The seams this plugin registers into. */
export const inject = ['tools']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Environment label (`local` / `staging` / `production`); evidence metadata only. */
  env: string
  /** Explicit repo name → path map (the original `datasources.code.repos`). */
  repos?: Record<string, string>
  /** Base directory globbed with `repoNamePattern` (the original `base_dir`). */
  baseDir?: string
  /** Glob for `baseDir` children, default `novo-*`. */
  repoNamePattern?: string
  /** Single repository path (the original `repo_path`). */
  repoPath?: string
}

export const Config: z<Config> = z.object({
  env: z.string().required().description('环境标识（local/staging/production），仅作为 evidence 元数据'),
  repos: z.dict(z.string()).description('仓库名 → 路径映射（原 datasources.code.repos）'),
  baseDir: z.string().description('仓库根目录，配合 repoNamePattern 通配（原 base_dir）'),
  repoNamePattern: z.string().default('novo-*').description('baseDir 下的仓库目录通配符，默认 novo-*'),
  repoPath: z.string().description('单一仓库路径（原 repo_path）'),
})

const SOURCE = 'code-repository'
const TYPE = 'code'
const DEFAULT_MAX_RESULTS = 20
const CODEGRAPH_DIR = '.codegraph'

const execFileAsync = promisify(execFile)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asEvidence(value: unknown): JsonValue {
  return value as JsonValue
}

/** Original `_codegraph_available`: the index directory exists and is non-empty. */
function codegraphAvailable(repoPath: string): boolean {
  const dir = resolve(repoPath, CODEGRAPH_DIR)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

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

/** Register the search and read tools. */
export function apply(ctx: Context, config: Config): void {
  const discover = (repoFilter?: string): RepoRef[] =>
    iterRepos(config, repoFilter).filter(repo => existsSync(repo.path))

  ctx.tools.register(defineTool({
    name: 'sentry_search_code',
    description:
      'Search code across the configured product repositories (CodeGraph index when present, ripgrep '
      + 'fallback): pass an error message, SQL fragment, function name, or log line to locate the '
      + 'repo/file/lines producing it. Read-only; returns snippets with line-number context.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keyword or error text (fixed-string, case-insensitive).' },
      repo: { type: 'string', description: 'Restrict to one repository (name or path); omit to search all configured repos.' },
      language: { type: 'string', description: 'Language filter: go, python, java, typescript, javascript, proto, sql, yaml, json.' },
      maxResults: { type: 'integer', default: DEFAULT_MAX_RESULTS, description: `Max snippets returned. Defaults to ${DEFAULT_MAX_RESULTS}.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const limit = args.maxResults ?? DEFAULT_MAX_RESULTS
      const repos = discover(args.repo)

      if (repos.length === 0) {
        // Original wording for the unconfigured case, adapted to plugin Config.
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: config.env,
            query: args.query,
            results: [],
            error: '未配置任何代码仓库，请在插件 Config 中设置 repos、baseDir 或 repoPath。',
          },
          summary: '未配置任何代码仓库，请在插件 Config 中设置 repos、baseDir 或 repoPath。',
          confidence: 0,
          refs: [`env:${config.env}:code`],
        }))
      }

      try {
        const all: CodeSnippet[] = []
        for (const repo of repos) {
          const indexed = codegraphAvailable(repo.path)
            ? await runCodegraphQuery(repo, args.query, limit)
            : []
          all.push(...(indexed.length > 0 ? indexed : await runRgQuery(repo, args.query, limit, args.language)))
        }

        all.sort((a, b) =>
          b.score - a.score
          || a.repo.localeCompare(b.repo)
          || a.file.localeCompare(b.file)
          || a.line_start - b.line_start,
        )
        const final = all.slice(0, limit)

        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: config.env,
            query: args.query,
            results: final,
          },
          summary: buildSearchSummary(final, args.query, repos.length),
          confidence: final.length > 0 ? 0.9 : 0.4,
          refs: [`env:${config.env}:code`],
        }))
      } catch (error) {
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: config.env, query: args.query, results: [], error: errorMessage(error) },
          summary: `代码搜索失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: [`env:${config.env}:code`],
        }))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentry_read_code',
    description:
      'Read a file (or a line range of it) from the configured product repositories, with line numbers. '
      + 'Read-only. Use after sentry_search_code to inspect the full context of a snippet.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository name (as returned by search results) or path.' },
      file: { type: 'string', required: true, description: 'File path relative to the repository root.' },
      startLine: { type: 'integer', description: 'First line to return (1-based). Defaults to 1.' },
      endLine: { type: 'integer', description: 'Last line to return. Defaults to the file end.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, _exec) {
      const refs = (): string[] => [`env:${config.env}:code`]
      try {
        const repo = discover(args.repo)[0]
        if (repo === undefined) {
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: config.env, repo: args.repo, file: args.file, error: `仓库 ${args.repo} 未配置或不存在` },
            summary: `仓库 ${args.repo} 未配置或不存在`,
            confidence: 0,
            refs: refs(),
          }))
        }

        const text = await readFile(resolve(repo.path, args.file), 'utf8')
        const lines = text.split('\n')
        const start = Math.max(1, args.startLine ?? 1)
        const end = Math.min(lines.length, args.endLine ?? lines.length)
        const numbered: string[] = []
        for (let ln = start; ln <= end; ln++) {
          numbered.push(`${ln}\t${lines[ln - 1]}`)
        }

        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: config.env,
            repo: repo.name,
            file: args.file,
            line_start: start,
            line_end: end,
            total_lines: lines.length,
            truncated: end < lines.length || start > 1,
            content: numbered.join('\n'),
          },
          summary: `读取 ${repo.name}/${args.file} 第 ${start}-${end} 行（共 ${lines.length} 行）。`,
          confidence: 0.95,
          refs: refs(),
        }))
      } catch (error) {
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: config.env, repo: args.repo, file: args.file, error: errorMessage(error) },
          summary: `读取文件失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: refs(),
        }))
      }
    },
  }))
}
