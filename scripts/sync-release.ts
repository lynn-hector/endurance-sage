import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const check = process.argv.includes('--check')
const rootManifest = readJson(join(rootDir, 'package.json'))
const version = rootManifest.version as string
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Root version is not a valid release version: ${version}`)
}

const packagesDir = join(rootDir, 'packages')
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .flatMap(group => group.isDirectory()
    ? readdirSync(join(packagesDir, group.name), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(packagesDir, group.name, entry.name))
    : [])
  .filter(dir => existsSync(join(dir, 'package.json')))
  .sort()

const packageNames = []
for (const dir of packageDirs) {
  const path = join(dir, 'package.json')
  const manifest = readJson(path)
  packageNames.push(manifest.name)
  manifest.version = version
  delete manifest.private
  manifest.license = 'UNLICENSED'
  manifest.engines = { ...rootManifest.engines }
  manifest.repository = {
    type: 'git',
    url: 'git+https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git',
    directory: relative(rootDir, dir),
  }
  manifest.exports = {
    '.': {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
  }
  manifest.files = ['dist']
  if (manifest.name === '@dsh-sentry/env-matrix') manifest.files.push('envs.yml')
  if (manifest.name === '@dsh-sentry/sentry-skills') manifest.files.push('skills')
  if (manifest.name === '@dsh-sentry/sentry') manifest.files.push('cordis.patch.yml')
  manifest.scripts = {
    ...manifest.scripts,
    build: 'node ../../../scripts/build-package.mjs',
  }
  writeIfChanged(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

const bundlePath = join(rootDir, 'packages/bundle/sentry/package.json')
const bundle = readJson(bundlePath)
bundle.dependencies = {
  ...Object.fromEntries(packageNames
    .filter(name => name !== '@dsh-sentry/sentry')
    .sort()
    .map(name => [name, 'workspace:*'])),
  '@deepseek-ai/cordis': bundle.dependencies['@deepseek-ai/cordis'],
  '@deepseek-ai/schemastery': bundle.dependencies['@deepseek-ai/schemastery'],
}
bundle.dsh = { bundle: { patch: './cordis.patch.yml' } }
writeIfChanged(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`)

const matrixSource = join(rootDir, 'apps/agent/envs.yml')
const matrixTarget = join(rootDir, 'packages/core/env-matrix/envs.yml')
writeIfChanged(matrixTarget, readFileSync(matrixSource, 'utf8'))

const defaultEnv = 'dev-platform-hosted-0'
const matrix = readFileSync(matrixSource, 'utf8')
if (!new RegExp(`^${defaultEnv}:`, 'm').test(matrix)) {
  throw new Error(`Bundle default environment ${defaultEnv} is missing from apps/agent/envs.yml`)
}
const bundlePatch = `# 由 pnpm run sync:release 生成，勿手改。\n- insert:\n    - id: sentry\n      name: '@dsh-sentry/sentry'\n      config:\n        defaultEnv: ${defaultEnv}\n`
writeIfChanged(join(rootDir, 'packages/bundle/sentry/cordis.patch.yml'), bundlePatch)

if (check) process.stdout.write(`release metadata OK: ${packageDirs.length} packages at ${version}\n`)
else process.stdout.write(`synchronized ${packageDirs.length} packages at ${version}\n`)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeIfChanged(path, content) {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (previous === content) return
  if (check) throw new Error(`Release metadata is out of date: ${relative(rootDir, path)}; run pnpm sync:release`)
  writeFileSync(path, content)
}
