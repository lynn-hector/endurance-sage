import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CodeRepositoryService, {
  type CodeSnippet,
  type RepoRef,
  type SyncResult,
} from '@dsh-sentry/service-code-repository'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as codeRepository from '../src/index.ts'

/**
 * Fake-Provider contract test: the tools must reach the code leg only
 * through the `ctx.codeRepository` slot with backend-neutral intents
 * (query + filters, repo + file, dry-run flag), and keep the evidence
 * envelopes (unconfigured hint, numbered reads, sync summaries) owned by
 * the Consumer.
 */

class StubSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(): unknown[] {
    return []
  }

  async assemble(): Promise<{ sections: unknown[] }> {
    return { sections: [] }
  }
}

// The sync flow filters configured repos by existence on disk, so the fake
// repo must point at a real directory (empty is fine).
const REPO_DIR = mkdtempSync(join(tmpdir(), 'fake-code-repo-'))
const REPO: RepoRef = { name: 'demo', path: REPO_DIR }

const SNIPPET: CodeSnippet = {
  repo: 'demo',
  file: 'pkg/handler.go',
  line_start: 10,
  line_end: 12,
  content: 'func boom() {',
  score: 0.5,
}

const SYNC_OK: SyncResult = {
  repo: 'demo',
  path: '/tmp/demo',
  status: 'up_to_date',
  head_before: 'abc1234',
  codegraph_index: false,
}

class FakeCodeRepositoryService extends CodeRepositoryService {
  searches: Array<{ query: string; repo?: string; language?: string; limit?: number }> = []
  reads: Array<[string, string]> = []
  synced: Array<[RepoRef, boolean]> = []
  readMissing = false
  error?: Error

  override discoverRepos(repoFilter?: string): RepoRef[] {
    void repoFilter
    return [REPO]
  }

  override configuredRepos(repoFilter?: string): RepoRef[] {
    void repoFilter
    return [REPO]
  }

  override async searchCode(
    query: string,
    options: { repo?: string; language?: string; limit?: number } = {},
  ): Promise<CodeSnippet[]> {
    this.searches.push({ query, ...options })
    if (this.error) throw this.error
    return [SNIPPET]
  }

  override async readCodeFile(
    repoFilter: string,
    file: string,
  ): Promise<{ repo: RepoRef; content: string } | undefined> {
    this.reads.push([repoFilter, file])
    if (this.error) throw this.error
    if (this.readMissing) return undefined
    return { repo: REPO, content: 'a\nb\nc' }
  }

  override async syncOne(repo: RepoRef, dryRun: boolean): Promise<SyncResult> {
    this.synced.push([repo, dryRun])
    if (this.error) throw this.error
    return { ...SYNC_OK }
  }
}

interface Envelope {
  evidence: {
    data: Record<string, unknown>
    summary: string
    refs?: string[]
    confidence: number
  }
}

let ctx: Context
let service: FakeCodeRepositoryService

afterAll(() => {
  rmSync(REPO_DIR, { recursive: true, force: true })
})

beforeEach(async () => {
  // Isolate from the machine's real assembly files so config.env ('test') is
  // the env label the evidence carries.
  vi.stubEnv('DSH_SENTRY_ASSEMBLY_DIR', '/nonexistent-assembly-dir')
  ctx = new Context()
  await ctx.plugin(StubSystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeCodeRepositoryService, { repos: { demo: REPO_DIR } })
  service = ctx.codeRepository as FakeCodeRepositoryService
  await ctx.plugin(codeRepository, { env: 'test' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
})

function tool(name: 'sentry_search_code' | 'sentry_read_code' | 'sentry_sync_code') {
  const found = ctx.tools.get(name)
  if (found === undefined) throw new Error(`${name} not registered`)
  return found
}

describe('tool-code-repository CodeRepositoryService Consumer', () => {
  it('searches through the seam with neutral intent', async () => {
    const output = await tool('sentry_search_code').execute({
      query: 'boom',
      language: 'go',
      maxResults: 5,
    }, {} as never) as Envelope

    expect(service.searches).toEqual([{ query: 'boom', language: 'go', limit: 5 }])
    expect(output.evidence.data).toMatchObject({
      env: 'test',
      query: 'boom',
      results: [SNIPPET],
    })
    expect(output.evidence.summary).toContain("在 1 个仓库中搜索 'boom'")
    expect(output.evidence.refs).toEqual(['env:test:code'])
    expect(output.evidence.confidence).toBe(0.9)
  })

  it('reads number the lines in the Consumer, not the Provider', async () => {
    const output = await tool('sentry_read_code').execute({
      repo: 'demo',
      file: 'a.txt',
      startLine: 2,
      endLine: 3,
    }, {} as never) as Envelope

    expect(service.reads).toEqual([['demo', 'a.txt']])
    expect(output.evidence.data).toMatchObject({
      repo: 'demo',
      file: 'a.txt',
      line_start: 2,
      line_end: 3,
      total_lines: 3,
      truncated: true,
      content: '2\tb\n3\tc',
    })
    expect(output.evidence.confidence).toBe(0.95)
  })

  it('an undiscovered repo is its own evidence branch', async () => {
    service.readMissing = true
    const output = await tool('sentry_read_code').execute({
      repo: 'nope',
      file: 'a.txt',
    }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({
      repo: 'nope',
      error: '仓库 nope 未配置或不存在',
    })
  })

  it('sync loops the configured repos and keeps dry-run inspection read-only', async () => {
    const synced = await tool('sentry_sync_code').execute({}, {} as never) as Envelope
    expect(service.synced).toEqual([[REPO, false]])
    expect(synced.evidence.confidence).toBe(1)
    expect(synced.evidence.summary).toContain('1 个已是最新')

    const dry = await tool('sentry_sync_code').execute({ dryRun: true }, {} as never) as Envelope
    expect(service.synced).toEqual([[REPO, false], [REPO, true]])
    expect(dry.evidence.summary).toContain('dry-run：目标 1 个仓库')
    expect(dry.evidence.confidence).toBe(1)
  })

  it('Provider failures stay inside the evidence envelope', async () => {
    service.error = new Error('rg: maxBuffer exceeded')
    const output = await tool('sentry_search_code').execute({ query: 'boom' }, {} as never) as Envelope

    expect(output.evidence.confidence).toBe(0)
    expect(output.evidence.data).toMatchObject({ error: 'rg: maxBuffer exceeded' })
    expect(output.evidence.refs).toEqual(['env:test:code'])
  })
})
