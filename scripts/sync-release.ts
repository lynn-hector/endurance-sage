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
  // 插件管理器的 display meta 由 dsh-app-boot 的 readPluginMeta 读取：只认包内导出的
  // locale/<lang>.json 与 manifest 的 icon 字段。bundle 需额外导出这两个子路径，
  // 否则 listPlugins 对该条目没有 meta（fallback 也不生效，因为 ./package.json 未导出）。
  if (manifest.name === '@dsh-sentry/sentry') {
    manifest.exports['./package.json'] = './package.json'
    manifest.exports['./locale/*.json'] = './locale/*.json'
  }
  // env-matrix 的纯词汇模块（零 Node 依赖）：web 客户端 bundle 需要按子路径内联。
  if (manifest.name === '@dsh-sentry/env-matrix') {
    manifest.exports['./pure'] = {
      types: './dist/pure.d.ts',
      default: './dist/pure.js',
    }
  }
  // ui-settings 是双面包包：浏览器半由 DSH client module system 经 ./client 提供。
  if (manifest.name === '@dsh-sentry/ui-settings') {
    manifest.exports['./client'] = './dist/client.js'
  }
  manifest.files = ['dist']
  if (manifest.name === '@dsh-sentry/env-matrix') manifest.files.push('envs.yml')
  if (manifest.name === '@dsh-sentry/sentry-skills') manifest.files.push('skills')
  if (manifest.name === '@dsh-sentry/sentry') manifest.files.push('cordis.patch.yml', 'locale/*.json', 'icon.svg')
  manifest.scripts = {
    ...manifest.scripts,
  }
  // 自带构建脚本的包（如 ui-settings：矩阵嵌入 + esbuild client bundle）保持原样。
  if (manifest.scripts.build === undefined) {
    manifest.scripts.build = 'node ../../../scripts/build-package.mjs'
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
// sentry-ui-settings 是 profile 级 Loader 条目（client 半由 dsh-client-modules
// 扫描 Loader 条目提供），不进 sentry 聚合的库式 ctx.plugin 列表。
const bundlePatch = `# 由 pnpm run sync:release 生成，勿手改。\n- insert:\n    - id: sentry\n      name: '@dsh-sentry/sentry'\n      config:\n        defaultEnv: ${defaultEnv}\n    - id: sentry-ui-settings\n      name: '@dsh-sentry/ui-settings'\n`
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
