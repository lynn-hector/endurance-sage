/**
 * Code repository tools: cross-repo code search, file reading and ff-only
 * sync.
 *
 * Consumer of the named `ctx.codeRepository` service seam: repo discovery,
 * the search engines (CodeGraph index preferred, ripgrep fallback), file
 * reads, the ff-only sync and the codegraph index self-healing live in
 * `@dsh-sentry/service-code-repository` (see its search.ts / sync.ts for
 * the ported script-era vocabulary and the marker contract); this package
 * holds only the tool schemas and the evidence envelopes, plus the summary
 * wording re-exported from the service.
 *
 * Why a tool at all, when the agent runtime has native file tools: the
 * session sandbox confines those to the session workspace, while the
 * product repositories live elsewhere on disk. Executing through the
 * harness process (like every sentry service does for HTTP) gives the
 * model controlled READ-ONLY visibility into the code: the subprocess
 * surface is `rg` and file reads, nothing else.
 *
 * Recorded deviations from the script era (unchanged by the seam split):
 * - `sentry_read_code` is NEW: the SKILL.md promised "读取指定文件或文件
 *   片段" but query.py had no such capability. The gap is closed here.
 * - `sentry_sync_code` is NEW (not in the script era at all): `git pull
 *   --ff-only` over the configured repos so code evidence can be refreshed
 *   in-band; fixed argv + configured-repos-only keeps it inside the
 *   guardrails git-guard usually enforces on bash (see the service's
 *   sync.ts). Updated repos with a `.codegraph/` index get an incremental
 *   reindex in the same call, and out-of-band HEAD drift self-heals via
 *   the marker contract (`codegraph sync|init`, non-fatal on failure).
 * - Output uses the standard `{ evidence: ... }` envelope (the script
 *   printed bare `{query, results, summary}`).
 * - `--env` disappeared: repo discovery moved from `config/{env}.yml`
 *   `datasources.code` into the service's Config.
 *
 * @module @dsh-sentry/tool-code-repository
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildEvidence } from '@dsh-sentry/evidence'
import { assemblyAnchorEnv } from '@dsh-sentry/env-matrix'
import {
  buildSearchSummary,
  buildSyncSummary,
  type SyncResult,
} from '@dsh-sentry/service-code-repository'
import type {} from '@dsh-sentry/service-code-repository'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-code-repository'

/** The seams this plugin registers into. */
export const inject = ['tools', 'codeRepository']

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Env label fallback when the assembly files are unreadable (local dev hosts set it explicitly; matrix assemblies omit it). */
  env?: string
  /** Enable sentry_sync_code: `git pull --ff-only` over the configured repos. Default on; the pull is fast-forward-only and never discards local work. */
  syncEnabled?: boolean
}

export const Config: z<Config> = z.object({
  env: z.string().description('环境标签回退值：装配文件不可读时使用；矩阵装配不设置，本地 dev host 显式传'),
  syncEnabled: z.boolean().default(true).description('启用 sentry_sync_code（对配置仓库执行 git pull --ff-only）。默认启用；只快进、不合并、不丢弃本地改动。'),
})

const SOURCE = 'code-repository'
const TYPE = 'code'
const DEFAULT_MAX_RESULTS = 20

/** Shared activation hint for the unconfigured case (search and sync agree on wording). */
const UNCONFIGURED_MSG =
  '未配置任何代码仓库：服务 Config 未设置 repos/baseDir/repoPath。装配管线启用方式: 用 pnpm --filter @dsh-sentry/agent run clone-repos 把 backend 组仓库引导 clone 到 <目录>，把 DSH_SENTRY_CODE_BASE=<该目录> 写入 $DSH_HOME/.credentials.yaml（refs: 下，推荐）或环境变量后重跑 regenerate（见 docs/guides/onboarding.md）。'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asEvidence(value: unknown): JsonValue {
  return value as JsonValue
}

/** Register the search, read and (config-gated) sync tools. */
export function apply(ctx: Context, config: Config): void {
  // Env label resolves per call from the assembly anchor: this plugin injects
  // a service, so a service config swap can leave this instance frozen on
  // boot-time config (see @dsh-sentry/env-matrix).
  const anchorEnv = (): string => assemblyAnchorEnv() ?? config.env ?? 'unknown'
  const refs = (): string[] => [`env:${anchorEnv()}:code`]

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
      const repoCount = ctx.codeRepository.discoverRepos(args.repo).length

      if (repoCount === 0) {
        // Original wording for the unconfigured case, adapted to the service Config.
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: anchorEnv(),
            query: args.query,
            results: [],
            error: UNCONFIGURED_MSG,
          },
          summary: UNCONFIGURED_MSG,
          confidence: 0,
          refs: refs(),
        }))
      }

      try {
        const final = await ctx.codeRepository.searchCode(args.query, {
          repo: args.repo,
          language: args.language,
          limit,
        })

        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: {
            env: anchorEnv(),
            query: args.query,
            results: final,
          },
          summary: buildSearchSummary(final, args.query, repoCount),
          confidence: final.length > 0 ? 0.9 : 0.4,
          refs: refs(),
        }))
      } catch (error) {
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: anchorEnv(), query: args.query, results: [], error: errorMessage(error) },
          summary: `代码搜索失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: refs(),
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
      try {
        const read = await ctx.codeRepository.readCodeFile(args.repo, args.file)
        if (read === undefined) {
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: anchorEnv(), repo: args.repo, file: args.file, error: `仓库 ${args.repo} 未配置或不存在` },
            summary: `仓库 ${args.repo} 未配置或不存在`,
            confidence: 0,
            refs: refs(),
          }))
        }

        const lines = read.content.split('\n')
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
            env: anchorEnv(),
            repo: read.repo.name,
            file: args.file,
            line_start: start,
            line_end: end,
            total_lines: lines.length,
            truncated: end < lines.length || start > 1,
            content: numbered.join('\n'),
          },
          summary: `读取 ${read.repo.name}/${args.file} 第 ${start}-${end} 行（共 ${lines.length} 行）。`,
          confidence: 0.95,
          refs: refs(),
        }))
      } catch (error) {
        return asEvidence(buildEvidence({
          source: SOURCE,
          type: TYPE,
          data: { env: anchorEnv(), repo: args.repo, file: args.file, error: errorMessage(error) },
          summary: `读取文件失败: ${errorMessage(error)}`,
          confidence: 0,
          refs: refs(),
        }))
      }
    },
  }))

  // Optional by config (default on). Fixed-argv `git pull --ff-only` over the
  // configured repos only — see the service's sync.ts for why this is safe
  // without git-guard.
  if (config.syncEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'sentry_sync_code',
      description:
        'Refresh the configured product repositories with git pull --ff-only, so code evidence matches the '
        + 'latest remote. Fast-forward only: never merges, never rewrites history, never discards local '
        + 'changes — a diverged or dirty repository returns its git error instead of being forced. '
        + 'Runs only on repositories from plugin config. When an updated repo carries a .codegraph index, '
        + 'an incremental codegraph sync refreshes it automatically (per-repo, non-fatal on failure).'
        + ' Reindexes on out-of-band HEAD drift (e.g. manual branch switches) by comparing '
        + 'a .git marker of the indexed HEAD, even when the pull itself is up-to-date or failed.',
      parameters: {
        repo: { type: 'string', description: 'Restrict to one configured repository (name or configured path); omit to sync all.' },
        dryRun: { type: 'boolean', default: false, description: 'List the target repositories with their current HEAD/branch without pulling.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, _exec) {
        const configured = ctx.codeRepository.configuredRepos()
        if (configured.length === 0) {
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: anchorEnv(), error: UNCONFIGURED_MSG },
            summary: UNCONFIGURED_MSG,
            confidence: 0,
            refs: refs(),
          }))
        }

        const repos = ctx.codeRepository.configuredRepos(args.repo).filter(repo => existsSync(repo.path))
        if (repos.length === 0) {
          const summary = `仓库 ${args.repo} 不在配置发现的仓库内（sync 只操作配置仓库：repos/baseDir/repoPath）。`
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: anchorEnv(), repo: args.repo, error: summary },
            summary,
            confidence: 0,
            refs: refs(),
          }))
        }

        try {
          const results: SyncResult[] = []
          for (const repo of repos) {
            results.push(await ctx.codeRepository.syncOne(repo, args.dryRun === true))
          }

          const failed = results.filter(result => result.status === 'error').length
          const summary = args.dryRun
            ? `dry-run：目标 ${results.length} 个仓库——${results.map(r => `${r.repo}@${r.branch ?? '?'}@${r.head_before ?? '?'}`).join('、')}；未执行 pull。`
            : buildSyncSummary(results)

          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: anchorEnv(), dry_run: args.dryRun ?? false, results },
            summary,
            confidence: failed === 0 ? 1 : failed < results.length ? 0.5 : 0,
            refs: refs(),
          }))
        } catch (error) {
          return asEvidence(buildEvidence({
            source: SOURCE,
            type: TYPE,
            data: { env: anchorEnv(), error: errorMessage(error) },
            summary: `同步仓库失败: ${errorMessage(error)}`,
            confidence: 0,
            refs: refs(),
          }))
        }
      },
    }))
  }
}
