import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Dependency-direction gate (skills-refactor-plan §3.1/§10.1):
 *
 *   Tool → Definition ← Provider, never Tool → Provider.
 *
 * Mechanically, for this repo:
 * 1. Tool packages may import from `@dsh-sentry/service-*` (named domain
 *    services and their pure vocabulary re-exports) ONLY as type-only or
 *    named bindings — never a default/namespace/dynamic import (the default
 *    export IS the Cordis Provider plugin), and never a class named
 *    `*Service` (the Provider class itself).
 * 2. Tool Configs must not carry Provider vocabulary: endpoint/credential/
 *    datasource/repo-discovery fields belong to the service side.
 * 3. Core (Definition/shared) packages must not depend on `service-*` or
 *    `tool-*` at all — dependency arrows point inward only.
 *
 * The scan is source-text based (imports + identifiers), so prose inside
 * strings/comments is stripped before the Config-vocabulary check to keep
 * user-facing wording (e.g. the unconfigured-repos hint mentioning
 * `repos/baseDir/repoPath`) out of the gate.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

function listPackages(group: 'tools' | 'core'): string[] {
  const dir = join(REPO_ROOT, 'packages', group)
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'src')))
    .map(entry => join(dir, entry.name, 'src'))
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

interface ImportClause {
  /** Import/export clause text between the keyword and `from`. */
  clause: string
  specifier: string
}

function scanImports(text: string): ImportClause[] {
  const found: ImportClause[] = []
  const statement = /(?:^|\n)\s*(?:import|export)\s+([^'";\n]+?)\s+from\s+['"]([^'"]+)['"]/g
  for (const match of text.matchAll(statement)) {
    found.push({ clause: match[1]!, specifier: match[2]! })
  }
  return found
}

function scanDynamicImports(text: string): string[] {
  return [...text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]!)
}

/** Strip comments and string bodies so prose cannot trip the token gate. */
function stripProse(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** Provider-class name-import guard: `*Service` bindings from service packages. */
const SERVICE_CLASS = /^[A-Z]\w*Service$/

const PROVIDER_CONFIG_TOKENS = [
  'endpointField',
  'credentialRefField',
  'secretField',
  'timeoutMsField',
  'tokenRef',
  'usernameRef',
  'passwordRef',
  'connectTokenRef',
  'datasourceUid',
  'datasourceId',
  'grafanaEndpoint',
  'postgresConnectionId',
  'redisConnectionId',
  'baseDir',
  'repoPath',
  'repoNamePattern',
]

function rel(path: string): string {
  return path.slice(REPO_ROOT.length + 1)
}

describe('dependency direction: Tool → Definition ← Provider', () => {
  const toolSrcDirs = listPackages('tools')
  const coreSrcDirs = listPackages('core')

  it('scans a non-trivial number of packages on both sides', () => {
    expect(toolSrcDirs.length).toBeGreaterThanOrEqual(11)
    expect(coreSrcDirs.length).toBeGreaterThanOrEqual(8)
  })

  it('tools never import the Provider plugin (default/namespace/dynamic) from service packages', () => {
    const violations: string[] = []
    for (const dir of toolSrcDirs) {
      for (const file of tsFiles(dir)) {
        const text = readFileSync(file, 'utf8')
        for (const { clause, specifier } of scanImports(text)) {
          if (!specifier.startsWith('@dsh-sentry/service-')) continue
          const normalized = clause.trim()
          if (normalized.startsWith('type ') || normalized.startsWith('type{')) continue
          // Default binding: a non-braced identifier before any '{'.
          const beforeBrace = normalized.split('{')[0]!.trim()
          if (beforeBrace.length > 0 && beforeBrace !== 'type') {
            violations.push(`${rel(file)}: default import "${beforeBrace}" from ${specifier}`)
          }
          if (normalized.includes('* as')) {
            violations.push(`${rel(file)}: namespace import from ${specifier}`)
          }
          for (const binding of normalized.match(/\{([^}]*)\}/)?.[1]?.split(',') ?? []) {
            const name = binding.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()
            if (SERVICE_CLASS.test(name)) {
              violations.push(`${rel(file)}: imports Provider class ${name} from ${specifier}`)
            }
          }
        }
        for (const specifier of scanDynamicImports(text)) {
          if (specifier.startsWith('@dsh-sentry/service-')) {
            violations.push(`${rel(file)}: dynamic import of ${specifier}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('tool Configs carry no Provider vocabulary (endpoint/credential/datasource/discovery fields)', () => {
    const violations: string[] = []
    for (const dir of toolSrcDirs) {
      for (const file of tsFiles(dir)) {
        const code = stripProse(readFileSync(file, 'utf8'))
        for (const token of PROVIDER_CONFIG_TOKENS) {
          if (new RegExp(`\\b${token}\\b`).test(code)) {
            violations.push(`${rel(file)}: provider-config token "${token}"`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('core packages depend on neither service nor tool packages', () => {
    const violations: string[] = []
    for (const dir of coreSrcDirs) {
      for (const file of tsFiles(dir)) {
        const text = readFileSync(file, 'utf8')
        for (const { specifier } of scanImports(text)) {
          if (/^@dsh-sentry\/(service|tool)-/.test(specifier)) {
            violations.push(`${rel(file)}: imports ${specifier}`)
          }
        }
        for (const specifier of scanDynamicImports(text)) {
          if (/^@dsh-sentry\/(service|tool)-/.test(specifier)) {
            violations.push(`${rel(file)}: dynamic import of ${specifier}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})
