#!/usr/bin/env node
/**
 * profile:link —— 把仓库内 apps/profile 的 sentry 核心接入 $DSH_HOME/profiles/<name>。
 *
 * 两种模式，按目标位置状态自动选择：
 *
 * 1) 符号链接模式（服务器）：目标不存在 → 建 ~/.dsh/profiles/<name> → apps/profile。
 *    profile 完全由仓库提供，dsh 直接装配。
 *
 * 2) 引入模式（本地开发机）：目标已是真实目录（你的个人 profile，装着市场插件）
 *    → 不替换目录，只做两件同步：
 *    a. 把 sentry 插件包以 link:<绝对路径> 并入该 profile 的 package.json
 *       （个人插件依赖原样保留；路径由本脚本计算，人不手改）
 *    b. 把该 profile 的 cordis.patch.yml 重写为一条 cordis-plugin-include 条目，
 *       指向 apps/profile/cordis.include.yml（sentry 核心的唯一来源是仓库）
 *       原有内容备份为 cordis.patch.yml.pre-sentry-core
 *
 * 之后（停 dsh 进程的窗口）在 profile 目录跑一次 pnpm install，重启即可。
 * 仓库侧新增 sentry 插件后：git pull → 重跑本脚本 → 停机 pnpm install → 重启。
 * GUI 市场装的个人插件写入同一 profile，仓库更新永不触碰。
 */
import { mkdirSync, copyFileSync, rmSync, symlinkSync, lstatSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = process.argv[2] ?? 'web'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const source = join(repoRoot, 'apps', 'profile')
const target = join(dshHome, 'profiles', profileName)
const includeYml = join(source, 'cordis.include.yml')

if (!existsSync(join(source, 'package.json'))) {
  console.error(`✗ 未找到 ${source}/package.json——请在仓库根目录运行`)
  process.exit(1)
}
if (!existsSync(includeYml)) {
  console.error(`✗ 未找到 ${includeYml}——先运行 pnpm --filter @dsh-sentry/agent run regenerate`)
  process.exit(1)
}

mkdirSync(join(dshHome, 'profiles'), { recursive: true })

/** sentry 核心包清单：name → 仓库内绝对路径。扫描 packages 各子包与 apps/profile 的 workspace 依赖求交集。 */
function sentryPackages() {
  const profilePkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const wanted = new Set(Object.entries(profilePkg.dependencies ?? {})
    .filter(([, spec]) => String(spec) === 'workspace:*').map(([name]) => name))
  const map = new Map()
  for (const group of ['core', 'services', 'tools', 'guard', 'skills']) {
    const gdir = join(repoRoot, 'packages', group)
    if (!existsSync(gdir)) continue
    for (const entry of readdirSync(gdir)) {
      const pj = join(gdir, entry, 'package.json')
      if (!existsSync(pj)) continue
      const { name } = JSON.parse(readFileSync(pj, 'utf8'))
      if (wanted.has(name)) map.set(name, join(gdir, entry))
    }
  }
  if (map.size !== wanted.size) {
    const missing = [...wanted].filter((n) => !map.has(n))
    console.error(`✗ 以下 workspace 包在 packages/ 下未找到：${missing.join(', ')}`)
    process.exit(1)
  }
  return map
}

if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
  // ── 引入模式（本地）──
  const sentry = sentryPackages()
  const pkgPath = join(target, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies ??= {}
  let added = 0
  for (const [name, path] of sentry) {
    const want = `link:${path}`
    if (pkg.dependencies[name] !== want) { pkg.dependencies[name] = want; added++ }
  }
  // include 插件本身也要在 profile 内可解析
  const includePlugin = '@deepseek-ai/cordis-plugin-include'
  if (pkg.dependencies[includePlugin] === undefined) {
    pkg.dependencies[includePlugin] = '^1.0.6'
    added++
  }
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  const patchPath = join(target, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const backup = join(target, 'cordis.patch.yml.pre-sentry-core')
    if (!existsSync(backup)) copyFileSync(patchPath, backup)
  }
  writeFileSync(patchPath, [
    '# sentry 核心经 cordis-plugin-include 引入（由 pnpm run profile:link 维护，勿手改）。',
    '# 个人/市场插件的原 patch 内容备份在 cordis.patch.yml.pre-sentry-core；bundles 由 package.json 管理。',
    '- insert:',
    '    - id: sentry-core',
    "      name: '@deepseek-ai/cordis-plugin-include'",
    '      config:',
    `        path: ${includeYml}`,
    '',
  ].join('\n'))

  console.log(`✓ 引入模式：${target}（真实目录，个人插件保留）`)
  console.log(`  · 依赖同步 ${added} 项（link: 指向仓库，路径自动计算）`)
  console.log(`  · ${patchPath} → include ${includeYml}`)
  console.log('下一步：停 dsh 进程 → 在 profile 目录 pnpm install → 重启。')
} else {
  // ── 符号链接模式（服务器）──
  try { if (lstatSync(target).isSymbolicLink()) rmSync(target) } catch { /* 不存在 */ }
  symlinkSync(source, target, 'dir')
  console.log(`✓ 符号链接模式：${target} -> ${source}`)
  console.log('下一步：dsh web（插件依赖已由仓库 pnpm install 就绪）')
}
