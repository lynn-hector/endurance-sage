#!/usr/bin/env node
/**
 * profile:link —— 把仓库内的 apps/profile 以符号链接接入 $DSH_HOME/profiles/web。
 *
 * 服务器（或本机）部署只有四步：
 *   git clone <repo> && cd dsh-sentry
 *   pnpm install                     # workspace:* 自动链接全部 sentry 插件
 *   pnpm run profile:link            # 本脚本：建 ~/.dsh/profiles/web → apps/profile
 *   dsh web                          # 起服务（GUI 监听 127.0.0.1:3080）
 *
 * 凭据：把本机 ~/.dsh/.credentials.yaml scp 到服务器同路径（权限 600）。
 * 代码检索腿：export DSH_SENTRY_CODE_BASE=<服务器上的 novo-commctl 路径> 后
 * 重新生成 patch（pnpm --filter @dsh-sentry/agent run regenerate）。
 *
 * 已存在非符号链接的 profiles/web 时拒绝覆盖，需先手动迁移。
 */
import { mkdirSync, rmSync, symlinkSync, lstatSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = process.argv[2] ?? 'web'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const target = join(dshHome, 'profiles', profileName)
const source = join(repoRoot, 'apps', 'profile')

if (!existsSync(join(source, 'package.json'))) {
  console.error(`✗ 未找到 ${source}/package.json——请在仓库根目录运行`)
  process.exit(1)
}

mkdirSync(join(dshHome, 'profiles'), { recursive: true })

if (existsSync(target)) {
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) {
    rmSync(target)
    console.log(`– 移除旧符号链接 ${target}`)
  } else {
    console.error(`✗ ${target} 已存在且不是符号链接（可能是手工维护的 profile）。`)
    console.error('  如确认弃用，先手动备份/删除后再运行本脚本。')
    process.exit(1)
  }
}

symlinkSync(source, target, 'dir')
console.log(`✓ ${target} -> ${source}`)
console.log(`  下一步：dsh --profile ${profileName} web（或 dsh web）`)
