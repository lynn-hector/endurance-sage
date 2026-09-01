# 新同事上手指南（本地接入 dsh-sentry）

目标：本机跑起一个带全部 8 条证据腿的排查 GUI（http://127.0.0.1:3080），默认环境 `dev-platform-hosted-0`（DP0）。预计 30–60 分钟，主要花在申请凭据上。

> 只读纪律：本工具集全部是只读查询，没有变更线上状态的能力。凭据只写本机 `~/.dsh/.credentials.yaml`，**永远不要**提交进任何仓库。

## TL;DR（给赶时间的人）

```bash
# 前置：node ≥ 22.19，corepack enable（或 npm i -g pnpm@11）
npm i -g @deepseek-ai/dsh
dsh web                       # 打开 http://127.0.0.1:3080 → 设置→模型 配好模型 → Ctrl+C 停掉
git clone https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git ~/dsh-sentry
cd ~/dsh-sentry && pnpm install
pnpm --filter @dsh-sentry/agent run regenerate
pnpm run profile:link
cd ~/.dsh/profiles/web && pnpm install    # 必须在 dsh 停机状态下
# 编辑 ~/.dsh/.credentials.yaml 填入凭据（见第 3 步）
dsh web                       # 开【新对话】验证
```

任何一步报错了，回到下面对应编号的详细步骤。

## 什么不用装（先排除干扰）

**8 条证据腿全部是纯 HTTPS 调用，没有任何 CLI/SDK 依赖：**

- ❌ zadig CLI——插件直调 Zadig OpenAPI，只要有 token
- ❌ TAPD 的 MCP server（`mcp-server-tapd`）——评估过，明确否决；插件直连 `api.tapd.cn`
- ❌ GreptimeDB / Grafana / RocketMQ 的任何客户端

## 第 0 步：前置条件

```bash
node --version    # ≥ 22.19（v24 也可以）
corepack enable   # 启用 pnpm；报错就用 npm i -g pnpm@11
```

## 第 1 步：dsh 宿主 + 模型

```bash
npm i -g @deepseek-ai/dsh
dsh --version     # 能看到版本号即成功
dsh web           # 打开 http://127.0.0.1:3080
```

GUI 里 **设置 → 模型**，二选一：

- **DeepSeek 官方**：DeepSeek 卡片填 API 密钥保存。
- **公司网关**：「添加自定义提供方」，填 Provider ID（小写，保存后不可改）、基础 URL、API 协议、密钥、至少一个模型 id。网关地址和模型名找维护者要。

在输入框的模型选择器选中该模型，**随便发一句话确认能正常回复**——不通则后面全白搭。报错自查：`MISSING_CREDENTIAL` = 密钥没配；`UNKNOWN_MODEL` = 模型 id 没加进提供方。

然后 **Ctrl+C 停掉 dsh web**。先跑一次是为了建出 `~/.dsh/profiles/web` 真实目录——第 2 步的接入脚本看到真实目录会走「引入模式」，sentry 核心与你个人插件共存；目录不存在则走符号链接模式，以后 GUI 市场装的插件会污染仓库目录。

## 第 2 步：仓库 + 接入

```bash
git clone https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git ~/dsh-sentry
cd ~/dsh-sentry
pnpm install
pnpm --filter @dsh-sentry/agent run regenerate   # 从 envs.yml 生成装配文件，默认 DP0
pnpm run profile:link                            # 预期输出含「✓ 引入模式」
cd ~/.dsh/profiles/web && pnpm install
```

**铁律：永远不要在 dsh 进程运行期间对 `~/.dsh/profiles/web` 跑 `pnpm install`**——会卡死 patch 热重载（有事故记录）。

**可选——代码检索腿**：`sentry_search_code` 需要本机有 novo-commctl 代码。未配置时 regenerate 会打 ⚠ 警告、该腿返回带启用方式的未配置提示，其余所有腿不受影响：

```bash
git clone <novo-commctl 仓库地址> ~/novo-commctl   # 里面应是 novo-* 各服务目录
```

代码根目录键名 `DSH_SENTRY_CODE_BASE`，三种来源按优先级取第一个：`envs.yml codeRepository.baseDir` > 环境变量 > 凭据库。**推荐写进凭据库**——和凭据同一个文件一次配齐（在 `refs:` 下加 `DSH_SENTRY_CODE_BASE: ~/novo-commctl`；路径不是机密，dsh 只解析 `*Ref` 引用的键，多余键对它无影响）；服务器等已有环境变量注入的场合继续 `export` 也行。配好后重跑 regenerate。

注意：代码检索腿的根目录（regenerate 时烘焙）与对话工作区是两个独立来源——排查会话**不要**把产品仓库选成会话工作区，两个检出的版本/行号可能漂移误导结论；代码事实以 `sentry_search_code` 证据为准。

## 第 3 步：凭据

编辑 `~/.dsh/.credentials.yaml`（不存在就新建）。**默认环境 DP0 需要这 9 个键**，键名一个字母都不能错：

```yaml
GREPTIMEDB_DP0_USERNAME: <grafana 账号>
GREPTIMEDB_DP0_PASSWORD: <密码>
GRAFANA_DP0_USERNAME: <admin>
GRAFANA_DP0_PASSWORD: <密码，每环境独立>
DBX_DP0_PASSWORD: <dbx 平台密码>
ROCKETMQ_DP0_USERNAME: <console 用户名>
ROCKETMQ_DP0_PASSWORD: <密码>
ZADIG_API_TOKEN: <Zadig 页面头像 → 个人设置 → OpenAPI → 创建 token>
TAPD_TOKEN: <TAPD 网页 → 我的设置 → 个人访问令牌>
```

| 凭据 | 说明 |
|---|---|
| ZADIG_API_TOKEN | 长期有效。**不要**从浏览器开发者工具复制请求头 token——那是 dex 会话 token，约 1 小时过期 |
| TAPD_TOKEN | 权限跟你的项目角色走，不需要管理员审批；细节见 [../integrations/tapd-integration.md](../integrations/tapd-integration.md) |
| 其余四项 | 找环境管理员；GreptimeDB 三环境（DP0/DP1/DC0）实测同凭据，Grafana 每环境独立 |

启用其他环境（DP1/DC0/TP0/TP1/TC0）：把键名里的 `DP0` 换成对应短码补进凭据库即可，**补齐凭据 = 启用环境**，矩阵不用改。

验证就绪度（不用启动 dsh）：

```bash
cd ~/dsh-sentry
pnpm --filter @dsh-sentry/agent run use-env --list   # 缺哪个键一目了然
```

## 第 4 步：启动并验证

```bash
dsh web    # 打开 http://127.0.0.1:3080，开【新对话】（旧对话不含新工具目录）
```

新对话里依次发三句话：

1. 「列出所有环境」→ 返回 6 环境表格 + 当前 DP0 = **插件加载成功**
2. 「列出近 30 分钟有日志的服务」→ 返回服务清单 = **凭据链路通**
3. 「查一下 zadig 上 commctl-config 的最近部署」→ 返回部署详情 = **全腿可用**

终端预检（不开 GUI）：`dsh --profile web --dump-config | grep sentry-` 应看到约 16 行 sentry-* 插件。

## 常见坑速查

| 症状 | 原因与处理 |
|---|---|
| 模型说没有 sentry 工具 | 对话是装插件前开的旧对话 → 开新对话；或装完没重启 dsh web |
| evidence 报「endpoint 或凭据缺失」 | 键名拼错或没写进 `~/.dsh/.credentials.yaml`，逐字母对照第 3 步 |
| evidence 报 `401` | 凭据值本身错了，链路是好的 |
| 切环境被拒绝 | 目标环境凭据键没补齐，`use-env --list` 看缺哪个；键明明已填仍全量报缺 → 凭据在 dsh GUI 管理的 `refs:` 嵌套层，`git pull` 更新本仓库后重跑（校验已兼容两种形态） |
| patch 改了不生效 | 在 dsh 运行期间对 profile 目录跑过 `pnpm install`？重启 dsh web |
| `pnpm install` 后类型冲突 | 不要单独 pin `@deepseek-ai/dsh-*` 某个包版本，全仓库统一 `^0.1.0-rc.7` 范围 |

## 日常更新（仓库有更新时）

```bash
# 1. 停 dsh web
cd ~/dsh-sentry && git pull && pnpm install
# 2. commit 动过 apps/agent/envs.yml 时：
pnpm --filter @dsh-sentry/agent run regenerate
# 3. 插件包有增删时：
pnpm run profile:link && (cd ~/.dsh/profiles/web && pnpm install)
# 4. 重启 dsh web
```

个人在 GUI 市场装的插件写入同一 profile，仓库更新永远不会碰它们。

## 进阶阅读

| 我想… | 看这里 |
|---|---|
| 对话内切换环境（不重启不断会话） | [env-switching.md](env-switching.md) |
| 换 token / 挂新插件包 | [credentials.md](credentials.md) |
| headless 一次性任务模式 | [runbook.md](runbook.md) |
| 排查方法论与各工具边界 | 对话里直接让模型加载对应 skill，或看 `packages/skills/` |
