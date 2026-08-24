import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildRgSnippets,
  buildSearchSummary,
  dedupeRepos,
  iterRepos,
  languageGlobs,
  normalizeFile,
  type RepoRef,
} from '../src/search.ts'
import { runRgQuery } from '../src/index.ts'

/**
 * Golden tests porting the original query.py helpers: repo discovery
 * (repos map / baseDir glob / repoPath + filter + dedupe), language
 * globs, snippet merging, and the ripgrep event path against fixture
 * repositories using the real `rg` binary.
 */

let base: string
let repoA: string
let repoB: string
let otherDir: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-code-repo-'))
  repoA = join(base, 'novo-commctl-config')
  repoB = join(base, 'novo-commctl-call-control')
  otherDir = join(base, 'unrelated-dir')
  mkdirSync(join(repoA, 'internal', 'data'), { recursive: true })
  mkdirSync(join(repoB, 'internal', 'biz'), { recursive: true })
  mkdirSync(otherDir)

  // 8 lines so line 5 has ±2 context on both sides.
  const redis = [
    'package data',
    '',
    'func ConnectRedis() error {',
    '\t// timeout connecting to redis',
    '\treturn dial("redis:6379", WithTimeout(3*time.Second))',
    '}',
    '',
    '// end of file',
  ].join('\n')
  writeFileSync(join(repoA, 'internal', 'data', 'redis.go'), redis)
  writeFileSync(join(repoA, 'internal', 'data', 'redis.py'), 'timeout connecting to redis\n')
  writeFileSync(
    join(repoB, 'internal', 'biz', 'call.go'),
    'func PlaceCall() error {\n\treturn connectDownstream()\n}\n',
  )
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('repo discovery (iterRepos)', () => {
  it('prefers the explicit repos map and dedupes by resolved path', () => {
    const repos = iterRepos({
      repos: { alpha: repoA, beta: resolve(repoA), gamma: repoB },
    })
    expect(repos).toHaveLength(2)
    expect(repos[0]).toEqual({ name: 'alpha', path: resolve(repoA) })
    expect(repos[1]?.name).toBe('gamma')
  })

  it('globs baseDir with the novo-* default pattern', () => {
    const repos = iterRepos({ baseDir: base })
    expect(repos.map(repo => repo.name)).toEqual([
      'novo-commctl-call-control',
      'novo-commctl-config',
    ])
    // the non-matching directory is excluded
    expect(repos.some(repo => repo.name === 'unrelated-dir')).toBe(false)
  })

  it('repoPath stands alone and basename becomes the name', () => {
    expect(iterRepos({ repoPath: repoA })).toEqual([{ name: 'novo-commctl-config', path: resolve(repoA) }])
  })

  it('unconfigured yields nothing', () => {
    expect(iterRepos({})).toEqual([])
  })
})

describe('repo filter (applyFilter semantics inside iterRepos)', () => {
  it('matches by name', () => {
    const repos = iterRepos({ baseDir: base }, 'novo-commctl-config')
    expect(repos).toHaveLength(1)
    expect(repos[0]?.name).toBe('novo-commctl-config')
  })

  it('falls back to an existing directory standing alone', () => {
    const repos = iterRepos({ baseDir: base }, otherDir)
    expect(repos).toEqual([{ name: 'unrelated-dir', path: resolve(otherDir) }])
  })

  it('unmatched filter yields nothing', () => {
    expect(iterRepos({ baseDir: base }, 'no-such-repo')).toEqual([])
  })
})

describe('pure helpers', () => {
  it('languageGlobs covers known languages and falls back to *.lang', () => {
    expect(languageGlobs()).toEqual([])
    expect(languageGlobs('go')).toEqual(['*.go'])
    expect(languageGlobs('YAML')).toEqual(['*.yml', '*.yaml'])
    expect(languageGlobs('kt')).toEqual(['*.kt'])
  })

  it('normalizeFile strips ./ and repo roots', () => {
    expect(normalizeFile('./internal/data/redis.go', repoA)).toBe('internal/data/redis.go')
    expect(normalizeFile(`${repoA}/internal/data/redis.go`, repoA)).toBe('internal/data/redis.go')
    expect(normalizeFile('internal/data/redis.go', repoA)).toBe('internal/data/redis.go')
  })

  it('buildRgSnippets merges adjacent match ranges and keeps context', () => {
    const snippets = buildRgSnippets('repo', '/repo', {
      file: 'a.go',
      lines: [
        { line: 1, text: 'one', isMatch: true },
        { line: 2, text: 'two', isMatch: false },
        { line: 3, text: 'three', isMatch: true }, // adjacent to line 1's +2 context → merges
        { line: 9, text: 'nine', isMatch: true },  // far enough for a separate range
      ],
    })
    expect(snippets).toEqual([
      { repo: 'repo', file: 'a.go', line_start: 1, line_end: 5, content: 'one\ntwo\nthree\n\n', score: 0 }, // lines 4-5 absent from the event map → empty
      { repo: 'repo', file: 'a.go', line_start: 7, line_end: 11, content: '\n\nnine\n\n', score: 0 }, // only line 9 exists in the map
    ])
  })

  it('buildRgSnippets drops files without matches', () => {
    expect(buildRgSnippets('repo', '/repo', { file: 'a.go', lines: [{ line: 1, text: 'x', isMatch: false }] })).toEqual([])
  })

  it('dedupeRepos keeps the first name per resolved path', () => {
    const repos: RepoRef[] = [{ name: 'a', path: repoA }, { name: 'b', path: resolve(repoA) }]
    expect(dedupeRepos(repos)).toEqual([{ name: 'a', path: resolve(repoA) }])
  })

  it('buildSearchSummary matches the original wording', () => {
    const hit: RepoRef[] = [{ name: 'a', path: '/a' }]
    expect(buildSearchSummary([], 'q', 3)).toBe("在 3 个仓库中未找到与 'q' 相关的代码。")
    expect(
      buildSearchSummary(
        [{ repo: 'beta', file: 'f', line_start: 1, line_end: 1, content: '', score: 0 },
         { repo: 'alpha', file: 'g', line_start: 1, line_end: 1, content: '', score: 0 }],
        'q',
        hit.length,
      ),
    ).toBe("在 1 个仓库中搜索 'q'，返回 2 处结果，涉及仓库：alpha, beta。")
  })
})

describe('ripgrep engine (runRgQuery with the real rg binary)', () => {
  it('finds matches across repos with merged context ranges', async () => {
    const snippets = [
      ...(await runRgQuery({ name: 'config', path: repoA }, 'timeout connecting to redis', 20)),
    ]
    expect(snippets.length).toBeGreaterThan(0)
    const go = snippets.find(snippet => snippet.file.endsWith('redis.go'))
    expect(go).toBeDefined()
    expect(go?.line_start).toBe(2)
    expect(go?.line_end).toBe(6) // single match at line 4 → [4-2, 4+2]
    expect(go?.content).toContain('WithTimeout(3*time.Second)')
    expect(go?.score).toBe(0)
  })

  it('language filter restricts files', async () => {
    const snippets = await runRgQuery(
      { name: 'config', path: repoA },
      'timeout connecting to redis',
      20,
      'go',
    )
    expect(snippets.every(snippet => snippet.file.endsWith('.go'))).toBe(true)
  })

  it('no-match query yields empty (rg exit code 1)', async () => {
    const snippets = await runRgQuery({ name: 'config', path: repoA }, 'zzz-no-such-token', 20)
    expect(snippets).toEqual([])
  })
})
