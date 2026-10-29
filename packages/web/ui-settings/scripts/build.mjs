#!/usr/bin/env node
/**
 * @dsh-sentry/ui-settings 构建：
 *
 * 1. 嵌入矩阵：读取 packages/core/env-matrix/envs.yml（sync:release 已从
 *    apps/agent/envs.yml 同步），解析为 JSON 字面量写入 client/generated-matrix.ts
 *    （提交进仓库，与 cordis.patch.yml 同一"生成物可提交"惯例；build 时刷新）。
 * 2. host 半：复用统一构建脚本（tsc src → dist）。
 * 3. client 半：esbuild 打包 client/ 为单文件 CJS，套上 DSH client module
 *    的注册外壳 `window.__ModuleLoader__.load({ id, factory })`；react 系为
 *    external（浏览器侧由 shell seed 提供），其余依赖（含 @dsh-sentry/env-matrix/pure
 *    的纯推导）全部内联，保持 ./client 的 external 面最小。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import esbuild from 'esbuild'

const packageDir = fileURLToPath(new URL('../', import.meta.url))
const matrixSource = join(packageDir, '../../core/env-matrix/envs.yml')
const generatedTarget = join(packageDir, 'client/generated-matrix.ts')

// ── 1. 嵌入矩阵 ──
if (!existsSync(matrixSource)) {
  throw new Error(`环境矩阵不存在: ${matrixSource}——先在仓库根运行 pnpm run sync:release`)
}
const matrix = parse(readFileSync(matrixSource, 'utf8'))
const generated = [
  '// 由 scripts/build.mjs 生成（源：packages/core/env-matrix/envs.yml，勿手改；改环境请编辑 apps/agent/envs.yml）。',
  "import type { Matrix } from '@dsh-sentry/env-matrix/pure'",
  '',
  `export const MATRIX: Matrix = ${JSON.stringify(matrix, null, 2)} as unknown as Matrix`,
  '',
].join('\n')
writeIfChanged(generatedTarget, generated)
process.stdout.write('embedded matrix from envs.yml\n')

// ── 2. host 半（统一构建脚本） ──
const host = spawnSync('node', [join(packageDir, '../../../scripts/build-package.mjs')], {
  cwd: packageDir,
  stdio: 'inherit',
})
if (host.status !== 0) process.exit(host.status ?? 1)

// ── 3. client 半（esbuild + 注册外壳） ──
const result = await esbuild.build({
  entryPoints: [join(packageDir, 'client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  minify: false,
  write: false,
  logLevel: 'warning',
  outdir: 'dist',
})
const body = result.outputFiles[0]?.text
if (body === undefined) throw new Error('esbuild produced no output')
const bundle = [
  '// 由 scripts/build.mjs 生成（esbuild bundle + DSH client module 注册外壳），勿手改。',
  `window.__ModuleLoader__.load({`,
  `  id: "@dsh-sentry/ui-settings",`,
  `  factory: (require) => {`,
  `    var module = { exports: {} };`,
  `    var exports = module.exports;`,
  `    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  body,
  `    return module.exports;`,
  `  }`,
  `});`,
  '',
].join('\n')
mkdirSync(join(packageDir, 'dist'), { recursive: true })
writeIfChanged(join(packageDir, 'dist/client.js'), bundle)
process.stdout.write('built @dsh-sentry/ui-settings (host + client)\n')

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  writeFileSync(path, content)
}
