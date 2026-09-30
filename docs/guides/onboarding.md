# 新同事上手指南（本地接入 dsh-sentry）

目标：本机跑起一个带全部 8 条证据腿的排查 GUI（http://127.0.0.1:3090），默认环境 `dev-platform-hosted-0`（DP0）。预计 30–60 分钟，主要花在申请凭据上。

> 只读纪律：本工具集全部是只读查询，没有变更线上状态的能力。凭据只写本机 `~/.dsh/.credentials.yaml`，**永远不要**提交进任何仓库。

## TL;DR（给赶时间的人）

```bash
# 前置：node ≥ 22.19，corepack enable（或 npm i -g pnpm@11）
npm i -g @deepseek-ai/dsh
dsh web                       # 打开 http://127.0.0.1:3080 → 设置→模型 配好模型 → Ctrl+C 停掉
git clone https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git ~/dsh-sentry
cd ~/dsh-sentry && pnpm install
pnpm --filter @dsh-sentry/agent run regenerate
pnpm run profile:link sentry  # 独立 profile：~/.dsh/profiles/sentry → 仓库 apps/profile
# 编辑 ~/.dsh/.credentials.yaml 填入凭据（见第 3 步）
dsh --profile sentry --port 3090   # 打开 http://127.0.0.1:3090，开【新对话】验证
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

然后 **Ctrl+C 停掉 dsh web**。先跑一次只为两件事：配好模型、建出 `~/.dsh` 宿主目录。模型配置存在 `$DSH_HOME` 级（`settings.yaml`），所有 profile 共享——后面 sentry 独立 profile 直接复用，不用再配。你的个人日常 GUI 随时可以用 `dsh web`（3080）启动，和 sentry profile（3090）互不干扰。

## 第 2 步：仓库 + 接入

```bash
git clone https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git ~/dsh-sentry
cd ~/dsh-sentry
pnpm install
pnpm --filter @dsh-sentry/agent run regenerate   # 从 envs.yml 生成装配文件，默认 DP0
pnpm run profile:link sentry                     # 预期输出含「✓ 符号链接模式」
```

接入后是**独立 profile**：`~/.dsh/profiles/sentry` 是指向仓库 `apps/profile` 的符号链接，纯 sentry 核心，与个人 web profile 完全隔离（GUI 市场插件装不进来）。插件依赖已由仓库的 `pnpm install` 就绪，**不需要**再去 profile 目录 install。

**铁律：永远不要在 dsh 进程运行期间对仓库跑 `pnpm install`**——符号链接模式下 profile 的 `node_modules` 就是仓库的 `apps/profile/node_modules`，运行中重装会卡死 patch 热重载（有事故记录）。更新一律先停进程，见文末「日常更新」。

**备选——想和个人插件共存**：如果你希望 sentry 工具出现在自己的日常 `dsh web`（3080）里、和个人/市场插件并肩，改用引入模式：先 `dsh web` 跑一次建出 `~/.dsh/profiles/web` 真实目录，再 `pnpm run profile:link`（不带参数，默认 web），然后停机状态下 `cd ~/.dsh/profiles/web && pnpm install`。细节见 [deploy.md](deploy.md) 接入模式对照。

**可选——代码检索腿**：`sentry_search_code` 覆盖 GitLab `novoone/backend` 组全部仓库（commctl 各服务 + 网关/平台/电信音视频组件等）。未配置时 regenerate 会打 ⚠ 警告、该腿返回带启用方式的未配置提示，其余所有腿不受影响：

```bash
pnpm --filter @dsh-sentry/agent run clone-repos -- --target ~/novoone-backend
# 幂等可重跑（完整 clone 过的仓库跳过；中断留下的半成品目录会自动重新 clone）；
# 浅克隆 --depth 1（默认），日常更新交给 sentry_sync_code 的 ff-only pull
# 装有 codegraph 时脚本会为每个仓库自动建索引（未装自动回退 ripgrep；老检出无索引会补建）
```

代码根目录键名 `DSH_SENTRY_CODE_BASE`，三种来源按优先级取第一个：`envs.yml codeRepository.baseDir` > 环境变量 > 凭据库。**推荐写进凭据库**——和凭据同一个文件一次配齐（在 `refs:` 下加 `DSH_SENTRY_CODE_BASE: ~/novoone-backend`；路径不是机密，dsh 只解析 `*Ref` 引用的键，多余键对它无影响）；服务器等已有环境变量注入的场合继续 `export` 也行。配好后重跑 regenerate。

**GitLab 认证（clone 与后续 pull 共用）**：私有仓需要认证，配置一次后 clone 脚本和 `sentry_sync_code` 的 pull 都不再要密码，二选一：

| 方式 | 配置 |
|---|---|
| HTTPS + PAT（默认） | GitLab 建 Personal Access Token（`read_repository` 权限即可）；`git config --global credential.helper store` 后首次 clone 交互输入一次（用户名任意，密码填 token）。token 不进 dsh 凭据库，也不作为脚本参数传入；无终端交互（cron/CI）时先手工 clone 任一仓库一次完成凭据缓存，或改用 SSH key |
| SSH key | 公钥加到 GitLab 账号；clone 脚本加 `--ssh` 走 `git@gitlab.yeastar.com:` 形式 |

注意：代码检索腿的根目录（regenerate 时烘焙）与对话工作区是两个独立来源——排查会话**不要**把产品仓库选成会话工作区，两个检出的版本/行号可能漂移误导结论；代码事实以 `sentry_search_code` 证据为准。检出落后时可用 `sentry_sync_code` 就地刷新：它对配置发现的仓库执行 `git pull --ff-only`（只快进、不合并、不丢本地改动，分叉/脏仓库报错不强同步；可经插件配置 `syncEnabled: false` 关闭）。

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

**（可选）**同一文件顺手加一行 `DSH_SENTRY_CODE_BASE: <backend 组检出根目录>`（嵌套形态加在 `refs:` 下）即启用代码检索腿——来源与优先级见第 2 步。

| 凭据 | 说明 |
|---|---|
| ZADIG_API_TOKEN | 长期有效。**不要**从浏览器开发者工具复制请求头 token——那是 dex 会话 token，约 1 小时过期 |
| TAPD_TOKEN | 权限跟你的项目角色走，不需要管理员审批；细节见 [../integrations/tapd-integration.md](../integrations/tapd-integration.md) |
| 其余四项 | 找环境管理员；GreptimeDB 三环境（DP0/DP1/DC0）实测同凭据，Grafana 每环境独立 |

启用其他环境（DP1/DC0/TP0/TP1/TC0/SC1/SC2）：把键名里的 `DP0` 换成对应短码补进凭据库即可，**补齐凭据 = 启用环境**，矩阵不用改。

验证就绪度（不用启动 dsh）：

```bash
cd ~/dsh-sentry
pnpm --filter @dsh-sentry/agent run use-env --list   # 缺哪个键一目了然
```

## 第 4 步：启动并验证

```bash
dsh --profile sentry --port 3090    # 打开 http://127.0.0.1:3090，开【新对话】（旧对话不含新工具目录）
```

新对话里依次发三句话：

1. 「列出所有环境」→ 返回 6 环境表格 + 当前 DP0 = **插件加载成功**
2. 「列出近 30 分钟有日志的服务」→ 返回服务清单 = **凭据链路通**
3. 「查一下 zadig 上 commctl-config 的最近部署」→ 返回部署详情 = **全腿可用**

终端预检（不开 GUI）：`dsh --profile sentry --dump-config | grep sentry-` 应看到约 22 行 sentry-* 插件。

## 常见坑速查

| 症状 | 原因与处理 |
|---|---|
| 模型说没有 sentry 工具 | 对话是装插件前开的旧对话 → 开新对话；或装完没重启 sentry profile |
| evidence 报「endpoint 或凭据缺失」 | 键名拼错或没写进 `~/.dsh/.credentials.yaml`，逐字母对照第 3 步 |
| evidence 报 `401` | 凭据值本身错了，链路是好的 |
| 切环境被拒绝 | 目标环境凭据键没补齐，`use-env --list` 看缺哪个；键明明已填仍全量报缺 → 凭据在 dsh GUI 管理的 `refs:` 嵌套层，`git pull` 更新本仓库后重跑（校验已兼容两种形态） |
| `sentry_search_code` 报「未配置任何代码仓库」 | `DSH_SENTRY_CODE_BASE` 三个来源（envs.yml / 环境变量 / 凭据库）都没设——regenerate 时的 ⚠ 警告说的就是这件事；按第 2 步写入凭据库后重跑 regenerate |
| patch 改了不生效 | 在 dsh 运行期间对仓库跑过 `pnpm install`？停掉重启 sentry profile |
| `pnpm install` 后类型冲突 | 不要单独 pin `@deepseek-ai/dsh-*` 某个包版本，全仓库统一 `^0.1.0-rc.7` 范围 |
| 启动报 `duplicate loader entry id: <插件id>` | 自带 `cordis.patch.yml` 的第三方插件又被手工注册了一遍（`renderEntries()` 或手改 patch）→ 删掉手工条目重新 regenerate，只留依赖声明（2026-09-03 dsh-im 实测） |
| 装了第三方插件但不生效 | 只装了依赖、包名没进 `dsh.profile.bundles`（dsh 不扫描 node_modules）→ 追加进数组重启，验证见「给 sentry profile 加插件（SOP）」（2026-09-03 dsh-context 实测） |

## 日常更新（仓库有更新时）

```bash
# 1. 停 sentry 进程（Ctrl+C）
cd ~/dsh-sentry && git pull && pnpm install
# 2. commit 动过 apps/agent/envs.yml 时：
pnpm --filter @dsh-sentry/agent run regenerate
# 3. 重启：dsh --profile sentry --port 3090
```

符号链接模式下 profile 即仓库 `apps/profile`，插件包增删也不需要重跑 `profile:link`
（链接指向整个目录，自动生效）；只有符号链接本身被删了才需要重跑一次。

## 给 sentry profile 加插件（SOP）

sentry profile 是团队共享装配，加插件一律改仓库——**不要**直接改 `~/.dsh/profiles/sentry` 下的文件：那是符号链接指向的仓库生成物，手改会在下次 regenerate 时被静默覆盖，团队也拿不到。

**第一步先分型**：看插件包根目录带不带自带的 `cordis.patch.yml`：

```bash
ls apps/profile/node_modules/<包名>/cordis.patch.yml   # 装完后看；装前可在 npm 仓库页面看包内容
```

带（即 manifest 声明 `dsh.bundle`）→ 走**情形 A**（依赖 + bundles 列表，双注册缺一不可）；不带 → 走**情形 B**（必须走生成器注册）。

### 情形 A：第三方/市场插件（包声明 dsh.bundle / 自带 cordis.patch.yml）

如 `@xmanrui/dsh-im`、`dsh-context`。**注册 = 两件事**：依赖装进 profile 包 + 包名进 `apps/profile/package.json` 的 `dsh.profile.bundles` 数组——dsh 只按这个列表逐层叠加装配，**不扫描 node_modules**，只装依赖不进列表等于没装。四步：

```bash
# 1. 停 sentry 进程（铁律见第 2 步）
# 2. 依赖装进 profile 包（不是仓库根！）：
pnpm --filter @dsh-sentry/profile add <包名>
# 3. 手动把 "<包名>" 追加进 apps/profile/package.json 的 dsh.profile.bundles 数组
# 4. 重启：dsh --profile sentry --port 3090
```

commit 只涉及 `apps/profile/package.json` + `pnpm-lock.yaml` 两个文件。

- **为什么 bundles 要手动加**：`dsh plugin add` 本会在装依赖后自动 reconcile bundles 列表，但它在本 workspace 用不了——其 pnpm 在 profile 子目录执行会被 workspace 强制 `-w`，依赖落到仓库根（2026-09-03 dsh-im 实测：bundles 注册成功、依赖装错位置，两头对不齐）。
- **不要**再往 `renderEntries()`（`packages/core/env-matrix/src/index.ts`）加条目——插件自带的 patch 已注册同一个 id，再加一条启动即报 `duplicate loader entry id`（2026-09-03 dsh-im 实测事故，见常见坑速查）。
- **peer 警告**：`pnpm add` 报 `[WARN] Issues with peer dependencies` 说明插件期望的 `@deepseek-ai/dsh-*` 版本与 bundles 提供的有偏差（如 rc.7 vs rc.8）。装完照常重启实测；功能异常时优先怀疑该偏差，可降级插件版本或等 bundles 升级。

### 情形 B：仓库自研插件（`@dsh-sentry/*`，包内无 cordis.patch.yml）

自研包不会自动注册，五步：

1. 依赖写进 `apps/profile/package.json`（`workspace:*`）；根 `package.json` 的 devDependencies 同步加一条，供类型检查
2. `renderEntries()`（`packages/core/env-matrix/src/index.ts`）加 `{ id, name, config? }` 条目（需要凭据的用 `*Ref` 引用，值进凭据库）
3. 同步守门测试 `apps/agent/tests/render.test.ts`（插件总数 + id 顺序列表），跑 `pnpm --filter @dsh-sentry/agent run test`
4. `pnpm --filter @dsh-sentry/agent run regenerate`
5. 停机 `pnpm install` → 重启

### 验证与边界

```bash
dsh --profile sentry --dump-config | grep <插件id>   # 只读预检，不启动服务
```

第三方插件应恰好出现 1 次；带前端页面的插件重启后浏览器要**硬刷新**（Cmd+Shift+R）。

**个人/市场插件不要进 sentry 装配**（它是团队共享的纯 sentry 核心）——装进自己的 web profile：`dsh plugin --profile web add <包名>`（web 是独立真实目录，无需 `-w`），和个人插件共存另见第 2 步备选。

## 进阶阅读

| 我想… | 看这里 |
|---|---|
| 给 sentry profile 加/换插件 | 本文「给 sentry profile 加插件（SOP）」一节 |
| 对话内切换环境（不重启不断会话） | [env-switching.md](env-switching.md) |
| IM 渠道（dsh-im）会话复用、/new、切工作区 | [dsh-im.md](dsh-im.md) |
| 和个人 web 插件共存（引入模式） | 本文第 2 步备选 + [deploy.md](deploy.md) 接入模式对照 |
| 换 token | [credentials.md](credentials.md) |
| headless 一次性任务模式 | [runbook.md](runbook.md) |
| 排查方法论与各工具边界 | 对话里直接让模型加载对应 skill，或看 `packages/skills/` |
