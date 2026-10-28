# 新同事上手指南

目标：在本机运行带全部证据腿的 dsh-sentry，打开 `http://127.0.0.1:3090`，并能查询默认环境。默认发布环境为 `dev-platform-hosted-0`（DP0）。

> 只读纪律：工具集只执行只读查询。真实凭据只写入本机 `~/.dsh/.credentials.yaml`，不要提交到仓库或粘贴到对话中。

## 选择安装方式

- **普通使用者**：首次版本发布后，通过 GitLab Package Registry 安装 `@dsh-sentry/sentry`，不需要克隆本仓库。
- **维护者或尚未发布时使用**：克隆仓库，通过本地工作区和 `apps/profile` 运行。

两种方式都需要 DSH 宿主、模型配置和本机凭据。

## 第 1 步：准备 DSH 宿主和模型

环境要求为 Node `^22.19.0 || >=24.0.0`。本地工作区安装还需要 pnpm `11.22.0` 和 Git。

```bash
npm i -g @deepseek-ai/dsh
dsh --version
dsh web
```

打开 `http://127.0.0.1:3080`，在 **设置 → 模型** 中配置 DeepSeek 官方账号或公司网关，选择模型并发送一条消息确认可用。随后停止 `dsh web`。

模型配置保存在 `$DSH_HOME/settings.yaml`，可被 sentry profile 复用。个人 Web profile 与 sentry profile 可以使用不同端口同时运行。

## 第 2 步 A：通过 GitLab 安装

将以下内容写入本机 `.npmrc`，把 `<项目ID>` 替换为 dsh-sentry 项目首页显示的数字 ID：

```ini
@dsh-sentry:registry=https://gitlab.yeastar.com/api/v4/projects/<项目ID>/packages/npm/
//gitlab.yeastar.com/api/v4/projects/<项目ID>/packages/npm/:_authToken=${GITLAB_TOKEN}
```

`GITLAB_TOKEN` 只需具备读取软件包所需权限，不使用发布 token。

在已有 DSH profile 中安装指定版本：

```bash
dsh plugin --profile sentry add @dsh-sentry/sentry@<version>
dsh --profile sentry --dump-config
```

npm 安装不需要执行仓库中的 `pnpm install`、`build`、`regenerate` 或 `profile:link`。

## 第 2 步 B：使用本地工作区安装

如果 DSH 正在通过链接运行当前仓库，先停止进程，再安装依赖。

```bash
git clone https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git ~/dsh-sentry
cd ~/dsh-sentry
pnpm install
pnpm run build
pnpm --filter @dsh-sentry/agent run regenerate
pnpm run profile:link sentry
```

这会创建独立 sentry profile，链接到仓库的 `apps/profile`。本地链接模式下不要在 DSH 运行期间对仓库执行 `pnpm install`，以免触发 patch 热重载问题。

如果希望与个人 Web profile 共存，可使用 `pnpm run profile:link` 的引入模式；当前开发调试优先推荐独立 sentry profile。

## 第 3 步：配置凭据

编辑 `~/.dsh/.credentials.yaml`。默认 DP0 环境需要以下键名：

```yaml
GREPTIMEDB_DP0_USERNAME: <grafana 账号>
GREPTIMEDB_DP0_PASSWORD: <密码>
GRAFANA_DP0_USERNAME: <admin>
GRAFANA_DP0_PASSWORD: <密码>
DBX_DP0_PASSWORD: <dbx 平台密码>
ROCKETMQ_DP0_USERNAME: <console 用户名>
ROCKETMQ_DP0_PASSWORD: <密码>
ZADIG_API_TOKEN: <Zadig 长期 OpenAPI token>
TAPD_TOKEN: <TAPD 个人访问令牌>
```

注意事项：

- Zadig 使用个人设置中的长期 OpenAPI token，不要使用浏览器 dex 会话 token。
- TAPD token 的权限跟随个人项目角色。
- 其他环境的凭据键名以 `apps/agent/envs.yml` 为准，通常是替换环境短码。
- 凭据库可以是平铺键，也可以是 DSH GUI 管理的 `refs:` 嵌套形态。

本地工作区用户可检查各环境凭据就绪度：

```bash
cd ~/dsh-sentry
pnpm --filter @dsh-sentry/agent run use-env --list
```

npm 安装用户可以在启动后通过「列出所有环境」或「当前环境」查看就绪度。详细获取方式见[凭据管理](credentials.md)。

## 第 4 步：可选的代码检索腿

代码检索需要本机存在业务代码检出，并配置根目录 `DSH_SENTRY_CODE_BASE`。未配置时，其余证据腿不受影响。

维护者可以使用仓库中的引导脚本：

```bash
pnpm --filter @dsh-sentry/agent run clone-repos -- --target ~/novoone-backend
```

脚本支持幂等重跑、浅克隆和可用的 codegraph 索引；没有 codegraph 时回退到 ripgrep。npm 安装不包含这个维护脚本，也可以按相同仓库配置自行准备代码检出。

随后在 `~/.dsh/.credentials.yaml` 的 `refs:` 下配置：

```yaml
refs:
  DSH_SENTRY_CODE_BASE: ~/novoone-backend
```

也可以使用同名环境变量。整体优先级为 `envs.yml codeRepository.baseDir` > 环境变量 > 凭据库。修改机器路径后重启宿主即可，不需要 regenerate。

私有仓库的 clone 和后续 `sentry_sync_code` 共用 Git 认证，可使用 HTTPS + `read_repository` PAT 或 SSH key。`sentry_sync_code` 只执行 `git pull --ff-only`，遇到分叉或脏工作区会报错，不会强行覆盖本地改动。

## 第 5 步：启动并验证

```bash
dsh --profile sentry --dump-config
dsh --profile sentry --port 3090
```

打开 `http://127.0.0.1:3090` 并新建对话，依次验证：

1. 「列出所有环境」：返回环境和当前绑定，说明 bundle 已加载。
2. 「列出近 30 分钟有日志的服务」：返回服务清单，说明日志腿和凭据链路可用。
3. 「查一下 zadig 上 commctl-config 的最近部署」：返回部署详情，说明平台型数据源可用。

`dump-config` 只验证安装和配置，不代表外部数据源连通。可使用以下命令查看统一入口：

```bash
dsh --profile sentry --dump-config | grep -A 12 'sentry'
```

## 后续更新

### GitLab 安装

停止 DSH 后安装新版本，再检查并启动：

```bash
dsh plugin --profile sentry add @dsh-sentry/sentry@<new-version>
dsh --profile sentry --dump-config
dsh --profile sentry --port 3090
```

### 本地工作区

停止 DSH 后执行：

```bash
cd ~/dsh-sentry
git pull --ff-only
pnpm install
pnpm run build
```

如果更新包含 `apps/agent/envs.yml` 或需要恢复本地默认环境，再运行 `pnpm --filter @dsh-sentry/agent run regenerate`，随后重启。

## 常见坑

- **模型说没有 sentry 工具**：检查是否重启并新建对话，以及是否还保留旧的逐插件 patch。
- **本地源码修改不生效**：先执行 `pnpm run build`，当前包从 `dist` 加载。
- **凭据缺失**：逐字母核对键名和嵌套层级；空字符串也视为未配置。
- **代码检索提示未配置仓库**：设置 `DSH_SENTRY_CODE_BASE` 并重启宿主。
- **启动出现 duplicate loader entry**：移除旧的逐插件注册，只保留统一 bundle 入口。
- **DSH 依赖或类型冲突**：不要单独 pin 某个 `@deepseek-ai/dsh-*` 版本，当前统一使用 `0.2.1-rc.3` 版本线。

## 维护者扩展插件

自研插件不再直接加入 `apps/profile/package.json`。维护者在 `packages/` 中实现包，在 `renderEntries()` 中声明加载条目并更新测试，然后运行 `pnpm run sync:release`，由统一 bundle 依赖和发布流程接管。完整验证与发布步骤见[开发验证、发布与安装](development-release-install.md)，目录职责见 [apps/README.md](../../apps/README.md)。

更多使用方式：

- 对话内切换环境：[env-switching.md](env-switching.md)。
- headless 一次性任务：[runbook.md](runbook.md)。
- IM 会话与工作区：[dsh-im.md](dsh-im.md)。
- 服务器常驻部署：[deploy.md](deploy.md)。
