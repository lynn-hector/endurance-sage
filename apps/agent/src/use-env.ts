/**
 * use-env —— 启动装配生成器（CLI）。
 *
 * 用法：
 *   pnpm --filter @dsh-sentry/agent run use-env local            # 写入 web profile（下次启动生效）
 *   pnpm --filter @dsh-sentry/agent run use-env local -- --dry-run # 只打印，不写文件
 *   pnpm --filter @dsh-sentry/agent run use-env local -- --out apps/profile/cordis.patch.yml
 *   pnpm --filter @dsh-sentry/agent run use-env test -- --profile sentry-test
 *
 * 证据环境是 Session 级绑定（见 docs/architecture/session-env-routing.md）：
 * 本 CLI 只生成/更新启动装配与 runtime 默认环境（env-binding 的 defaultEnv
 * 锚点），不覆盖任何在线 Session 的已有绑定。运行期切换用 sentry_env_switch。
 *
 * 切换前按腿校验该环境引用的凭据值（envs.yml 的 *Ref 字段）在
 * $DSH_HOME/.credentials.yaml 或进程环境中就绪——缺值或空值只降级对应腿
 * 并告警，不拦截（该腿工具调用时按需报错，补值即恢复）。
 *
 * @module @dsh-sentry/agent/use-env
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  credentialReadiness,
  credentialStorePath,
  type EnvRow,
  extractCurrentEnv,
  type Matrix,
  renderPatch,
  renderIncludePatch,
  resolveCodeBaseDir,
  resolveEnvName,
} from './render.ts'

// fileURLToPath 而非 .pathname：Windows 上 pathname 带 /D:/ 前缀，join 后会被
// 解析成 D:\D:\… 双盘符路径（与 env-matrix defaultAssemblyPaths 同一惯用法）。
const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url))
const CREDENTIAL_STORE = credentialStorePath()

interface Args {
  env?: string
  profile: string
  out?: string
  dryRun: boolean
  list: boolean
  current: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { profile: 'web', dryRun: false, list: false, current: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--list') args.list = true
    else if (arg === '--current') args.current = true
    else if (arg === '--profile') args.profile = argv[++i] ?? ''
    else if (arg === '--out') args.out = argv[++i]
    else if (arg.startsWith('--')) {
      console.error(`未知参数: ${arg}`)
      process.exit(2)
    } else args.env = arg
  }
  return args
}

/** 可选代码检索腿的就绪提示：未配置或路径缺失时明确告知（stderr），不静默失效。 */
function warnCodeLeg(row: EnvRow): void {
  const base = resolveCodeBaseDir(row)
  if (base === undefined) {
    console.error('⚠ 代码检索腿未配置（可选，其余工具不受影响）: envs.yml 无 codeRepository.baseDir，环境变量与凭据库（$DSH_HOME/.credentials.yaml 的 DSH_SENTRY_CODE_BASE 键）也均未设置。')
    console.error('  启用方式: pnpm --filter @dsh-sentry/agent run clone-repos 引导 clone backend 组仓库后，把 DSH_SENTRY_CODE_BASE=<检出根目录> 写入凭据库 refs: 下（推荐，与凭据同文件）或 ~/.zshrc，重启宿主生效（服务构造期解析，无需 regenerate）。')
    return
  }
  if (!existsSync(base)) {
    console.error(`⚠ 代码检索腿目录不存在: ${base}，sentry_search_code 将找不到任何仓库——检查 DSH_SENTRY_CODE_BASE / envs.yml codeRepository.baseDir。`)
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const matrix = parse(readFileSync(join(AGENT_DIR, 'envs.yml'), 'utf8')) as Matrix

  if (args.current) {
    const target = join(homedir(), '.dsh', 'profiles', args.profile, 'cordis.patch.yml')
    if (!existsSync(target)) {
      console.error(`profile ${args.profile} 尚无组装文件: ${target}`)
      process.exit(1)
    }
    const text = readFileSync(target, 'utf8')
    const env = extractCurrentEnv(text) ?? '未知（装配文件无环境标记）'
    console.log(`profile ${args.profile} 当前部署环境: ${env}`)
    console.log(`  装配文件最后写入: ${statSync(target).mtime.toISOString()}`)
    return
  }

  if (args.list || args.env === undefined) {
    console.log('可用环境（envs.yml）:')
    for (const [name, row] of Object.entries(matrix)) {
      const missing = credentialReadiness(row, CREDENTIAL_STORE).flatMap((item) => item.missingRefs)
      const state = missing.length === 0 ? '就绪' : `缺凭据: ${missing.join(', ')}`
      console.log(`  ${name.padEnd(12)} ${row.envLabel.padEnd(12)} ${state}`)
    }
    if (!args.list) {
      console.log('\n用法: pnpm --filter @dsh-sentry/agent run use-env <环境名>')
      process.exit(args.env === undefined && !args.list ? 2 : 0)
    }
    return
  }

  const envName = resolveEnvName(args.env, matrix)
  const row = envName === undefined ? undefined : matrix[envName]
  if (envName === undefined || row === undefined) {
    console.error(`未知环境: ${args.env}（envs.yml 中没有这一行；--list 查看全部，支持 DP0/DP1/DC0/TP0/TP1/TC0/SC1/SC2 短名）`)
    process.exit(2)
  }

  // 缺值/空值只降级对应腿并告警，不拦截切换——该腿工具调用时按需报错，补值即恢复
  const degraded = credentialReadiness(row, CREDENTIAL_STORE).filter((item) => !item.ok)
  if (degraded.length > 0) {
    console.error(`⚠ 环境 ${envName} 有 ${degraded.length} 条腿凭据未就绪（不拦截切换，补值即恢复）:`)
    for (const item of degraded) {
      const mode = item.authMode !== undefined ? `(${item.authMode})` : ''
      console.error(`    ${item.leg}${mode}: ${item.missingRefs.join(', ')}`)
    }
  }

  const patch = renderPatch(row)
  warnCodeLeg(row)
  if (args.dryRun) {
    console.log(patch)
    return
  }

  const target = args.out ?? join(homedir(), '.dsh', 'profiles', args.profile, 'cordis.patch.yml')
  writeFileSync(target, patch)
  console.log(`✓ 环境 ${envName} → ${target}`)
  // 同步生成 include 格式（本地 profile「引入」模式消费），与 patch 同目录
  const includeTarget = target.replace(/cordis\.patch\.yml$/, 'cordis.include.yml')
  if (includeTarget !== target) {
    writeFileSync(includeTarget, renderIncludePatch(row))
    console.log(`✓ include 格式 → ${includeTarget}`)
  }
  console.log(`  启动装配/默认环境 ${envName} 已生成；运行期按 Session 用 sentry_env_switch 切换。`)
}

main()
