import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(readFileSync(join(rootDir, 'output/npm/manifest.json'), 'utf8'))
const smokeDir = join(rootDir, 'output/npm-smoke')
rmSync(smokeDir, { recursive: true, force: true })
mkdirSync(smokeDir, { recursive: true })
const tarballDependencies = Object.fromEntries(
  release.packages.map(pkg => [pkg.name, `file:${join(rootDir, pkg.tarball)}`]),
)
writeFileSync(join(smokeDir, 'package.json'), `${JSON.stringify({
  private: true,
  type: 'module',
  dependencies: {
    '@dsh-sentry/sentry': tarballDependencies['@dsh-sentry/sentry'],
  },
}, null, 2)}\n`)
const overrides = Object.entries(tarballDependencies)
  .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
  .join('\n')
writeFileSync(join(smokeDir, 'pnpm-workspace.yaml'), `overrides:\n${overrides}\n`)

const probe = join(smokeDir, 'probe.mjs')
writeFileSync(probe, `
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as bundle from '@dsh-sentry/sentry'
const require = createRequire(import.meta.resolve('@dsh-sentry/sentry'))
const { defaultEnvsPath, readMatrix, renderEntries } = await import(require.resolve('@dsh-sentry/env-matrix'))
const envsPath = defaultEnvsPath()
if (!existsSync(envsPath) || envsPath.includes('apps/agent')) throw new Error('packaged envs.yml was not resolved')
const matrix = readMatrix(envsPath)
const row = matrix['dev-platform-hosted-0']
if (!row) throw new Error('default environment is missing')
for (const entry of renderEntries(row)) await import(require.resolve(entry.name))
if (typeof bundle.apply !== 'function') throw new Error('aggregate bundle apply is missing')
const personaUrl = new URL('./persona.md', pathToFileURL(require.resolve('@dsh-sentry/sentry-persona')))
if (!readFileSync(personaUrl, 'utf8').includes('故障')) throw new Error('persona resource is missing')
const skillsUrl = new URL('../skills/project-context/SKILL.md', pathToFileURL(require.resolve('@dsh-sentry/sentry-skills')))
if (!existsSync(fileURLToPath(skillsUrl))) throw new Error('skills resource is missing')
console.log('tarball install smoke OK')
`)

const install = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
  cwd: smokeDir,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
})
if (install.status !== 0) process.exit(install.status ?? 1)
const test = spawnSync(process.execPath, [probe], { cwd: smokeDir, stdio: 'inherit' })
if (test.status !== 0) process.exit(test.status ?? 1)
