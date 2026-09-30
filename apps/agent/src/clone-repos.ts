/**
 * clone-repos —— backend 组全量仓库引导脚本（CLI）。
 *
 * 用法：
 *   pnpm --filter @dsh-sentry/agent run clone-repos -- --target ~/novoone-backend
 *   pnpm --filter @dsh-sentry/agent run clone-repos -- --dry-run   # 只打印将 clone 的清单
 *   pnpm --filter @dsh-sentry/agent run clone-repos -- --ssh --depth 1
 *
 * 首次把 GitLab novoone/backend 组的仓库浅克隆到一个根目录
 * （目录名即仓库名，tool-code-repository 的 novo-* 通配据此发现全部仓库）。
 * 日常更新不走本脚本——sentry_sync_code 对配置内仓库做 ff-only pull。
 *
 * 目标目录解析优先级：--target > DSH_SENTRY_CODE_BASE 环境变量 > 凭据库同名键
 * （复用 resolveCodeBaseDir，与 regenerate 烘焙 baseDir 的来源一致（本脚本无环境行上下文，不含 envs.yml 行内值））。
 *
 * 认证完全交给 git（credential helper / SSH key），脚本不经手任何凭据，
 * 也不提供 --token 类参数（token 会进 shell 历史与进程列表）。
 *
 * @module @dsh-sentry/agent/clone-repos
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expandHome, resolveCodeBaseDir } from './render.ts'

/** backend 组权威清单（来源 https://gitlab.yeastar.com/yeastar/novoone/backend）。
 *  组内新增仓库时在此手动补一行（发现机制的 novo-* 通配自动覆盖新名字）。 */
export const REPOS: readonly string[] = [
  'novo-ai-voice',
  'novo-bootstrap',
  'novo-branch',
  'novo-common-pluginsOwner',
  'novo-common-proto',
  'novo-commctl-autop',
  'novo-commctl-call-control',
  'novo-commctl-config',
  'novo-commctl-contact',
  'novo-commctl-kit',
  'novo-commctl-orbit',
  'novo-commctl-report',
  'novo-commctl-util',
  'novo-gateway',
  'novo-media-bridge',
  'novo-platform-backend',
  'novo-platform-user',
  'novo-plugins-deprecated',
  'novo-publish-center',
  'novo-telecom-ai-playbook',
  'novo-telecom-cdr',
  'novo-telecom-common',
  'novo-telecom-configs',
  'novo-telecom-freeswitch',
  'novo-telecom-opensips',
  'novo-telecom-rtpengine',
  'novo-telecom-template',
  'novo-upgrade',
]

const GROUP_HTTPS = 'https://gitlab.yeastar.com/yeastar/novoone/backend'
const GROUP_SSH = 'git@gitlab.yeastar.com:yeastar/novoone/backend'

/** 单仓库 clone 上限：慢链路上的大仓（freeswitch 等）depth 1 也通常远低于此值，
 *  只兜网络黑洞——挂死无输出比报错更难排查，且 cron/CI 场景会永不终止。 */
const CLONE_TIMEOUT_MS = 10 * 60_000

/** 并发 clone 数：4 路对 GitLab 服务端与本机带宽都友好，全组墙钟时间约降为串行的 1/4；
 *  git 认证按进程隔离（credential store / ssh-agent 均可并发），失败汇报互不影响。 */
const CLONE_CONCURRENCY = 4

/** 仓库 clone URL（ssh=true 走 SSH 形态，默认 HTTPS）。 */
export function repoUrl(repo: string, ssh: boolean): string {
  return ssh ? `${GROUP_SSH}/${repo}.git` : `${GROUP_HTTPS}/${repo}.git`
}

/** 解析后的命令行参数。 */
export interface CloneArgs {
  /** 目标根目录；缺省时 main 里经 resolveCodeBaseDir() 解析。 */
  target?: string
  /** clone 深度，默认 1（浅克隆；ff-only pull 与 codegraph/rg 检索都不需要历史）。 */
  depth: number
  /** SSH URL 形态。 */
  ssh: boolean
  /** 只打印清单不执行。 */
  dryRun: boolean
}

/** 解析 argv；未知参数/缺值/非法 depth 抛错（main 统一转 exit 2，便于单测）。
 *  裸 `--` 分隔符视为 no-op——pnpm v11 会把它原样透传给脚本，两种写法都要能用。 */
export function parseArgs(argv: string[]): CloneArgs {
  const args: CloneArgs = { depth: 1, ssh: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') continue
    else if (arg === '--ssh') args.ssh = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--target') {
      const value = argv[++i]
      if (value === undefined || value === '') throw new Error('--target 缺少值')
      if (value.startsWith('--')) throw new Error(`--target 的值不能以 -- 开头（疑似误传参数）: ${value}`)
      args.target = value
    } else if (arg === '--depth') {
      const raw = argv[++i]
      const depth = Number(raw)
      if (raw === undefined || !Number.isInteger(depth) || depth < 1) {
        throw new Error(`--depth 需为正整数: ${raw ?? '(缺值)'}`)
      }
      args.depth = depth
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return args
}

/** git 认证类失败的特征（HTTPS 与 SSH 形态都覆盖，触发汇总里的配置指引）。 */
export function isAuthFailure(stderr: string): boolean {
  return /Authentication failed|could not read Username|Access denied|Permission denied|Could not read from remote repository|HTTP 403|terminal prompts disabled/i.test(stderr)
}

/** 认证指引：只保留两条路线的一句话形态——详细步骤（PAT 建法、credential.helper、
 *  无终端环境的预置做法）唯一权威源是 docs/guides/onboarding.md 第 2 步「GitLab 认证」，
 *  改认证方式时只改那份，这里与 deploy.md 都指向它。 */
export const AUTH_HINT = [
  'GitLab 认证未通过（脚本本身不经手凭据）。两条路线任选其一:',
  '  1. HTTPS + PAT（默认）: GitLab 建 read_repository 权限 Personal Access Token，git config --global credential.helper store。',
  '  2. SSH key: 公钥加到 GitLab 账号，本脚本加 --ssh 参数。',
  '详细配置步骤见 docs/guides/onboarding.md 第 2 步「GitLab 认证」。',
].join('\n')

/** 判定「已是完整 clone」：.git 存在且 HEAD 可解析（与 sentry_sync_code 的有效性口径一致）。
 *  只看「目录非空」会把中断留下的半成品（甚至无 .git 的杂物目录）当成功静默跳过。 */
export function isCompleteClone(dir: string): boolean {
  if (!existsSync(resolve(dir, '.git'))) return false
  const probe = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
    stdio: 'ignore',
    timeout: 30_000,
  })
  return probe.status === 0
}

/** 目录是 git 半成品（有 .git 但 HEAD 不可解析——中断/超时 clone 的残留）时删除并返回 true，
 *  让随后的 clone 落进干净目录；git 拒绝非空目标，不清理则每次重跑都卡死在同一条报错上。
 *  无 .git 的目录不碰——可能是用户误放的数据，交给 git clone 的「目录非空」报错大声暴露。 */
export function recoverPartialClone(dir: string): boolean {
  if (!existsSync(resolve(dir, '.git')) || isCompleteClone(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** 异步 clone 单仓：永不 reject；失败给 reason（超时转译成中文）并保留 stderr 供认证失败汇总判定。 */
export function spawnClone(url: string, dir: string, depth: number): Promise<{ ok: boolean; reason: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['clone', '--depth', String(depth), url, dir], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CLONE_TIMEOUT_MS)
    // spawn 失败（如找不到 git）时 error 与 close 都会触发；Promise 重复 resolve 先到先得，无害
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: error.message, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, reason: '', stderr })
      else if (timedOut) resolve({ ok: false, reason: `clone 超时（>${CLONE_TIMEOUT_MS / 60_000} 分钟，疑似网络挂起）`, stderr })
      else resolve({ ok: false, reason: stderr.trim().split('\n').pop() || 'git clone 失败', stderr })
    })
  })
}

async function main(): Promise<void> {
  let args: CloneArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const rawTarget = args.target ?? resolveCodeBaseDir()
  if (rawTarget === undefined) {
    console.error('✗ 未指定目标目录: 传 --target <dir>，或设置 DSH_SENTRY_CODE_BASE（环境变量 / $DSH_HOME/.credentials.yaml 同名键）。')
    console.error('  用法: pnpm --filter @dsh-sentry/agent run clone-repos -- --target <dir>')
    process.exit(2)
  }
  // 引号里的 ~/x（Windows / 双引号场景）不会经 shell 展开，这里统一处理
  const target = expandHome(rawTarget)

  console.log(`目标根目录: ${resolve(target)}（${REPOS.length} 个仓库，depth ${args.depth}，${args.ssh ? 'SSH' : 'HTTPS'}）`)

  if (!args.dryRun) {
    try {
      mkdirSync(target, { recursive: true })
    } catch (error) {
      console.error(`✗ 无法创建目标根目录 ${resolve(target)}: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
  }

  const failures: { repo: string; stderr: string }[] = []
  let cloned = 0
  let skipped = 0
  const todos: string[] = []
  for (const repo of REPOS) {
    if (isCompleteClone(resolve(target, repo))) {
      console.log(`↷ 跳过 ${repo}（已是完整 clone，幂等可重跑）`)
      skipped++
    } else if (args.dryRun) {
      console.log(`… dry-run ${repo} ← ${repoUrl(repo, args.ssh)}`)
    } else {
      todos.push(repo)
    }
  }

  if (args.dryRun) {
    console.log(`dry-run 结束: 将 clone ${REPOS.length - skipped} 个、跳过 ${skipped} 个；未执行任何 git 操作。`)
    return
  }

  // 4 路并发消费待 clone 队列；每行输出自带仓库名，交错亦可读
  const queue = [...todos]
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const repo = queue.shift()!
      const dir = resolve(target, repo)
      if (recoverPartialClone(dir)) console.log(`♻ 清理半成品 ${repo}（中断/超时残留），重新 clone`)
      console.log(`→ clone ${repo}`)
      const result = await spawnClone(repoUrl(repo, args.ssh), dir, args.depth)
      if (result.ok) {
        cloned++
        console.log(`✓ ${repo}`)
      } else {
        console.error(`✗ ${repo}: ${result.reason}`)
        failures.push({ repo, stderr: result.stderr })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLONE_CONCURRENCY, todos.length) }, () => worker()))

  console.log(`完成: 成功 ${cloned}、跳过 ${skipped}、失败 ${failures.length}（共 ${REPOS.length}）`)
  console.log('  清单为手工维护（REPOS）：GitLab backend 组新增仓库时需在 apps/agent/src/clone-repos.ts 补一行，否则代码检索不覆盖新仓库。')
  if (failures.some(({ stderr }) => isAuthFailure(stderr))) {
    console.error(AUTH_HINT)
  }
  if (failures.length > 0) process.exit(1)
}

// 仅作为脚本直接执行时跑 main（vitest 导入纯函数不触发 CLI 行为）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main()
}
