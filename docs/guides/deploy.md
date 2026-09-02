# 服务器部署指南

dsh-sentry 在远程服务器的部署 = 仓库 + DSH 宿主 + 凭据 三件套。

profile 有两种接入模式（`pnpm run profile:link` 按目标状态自动选择）：

| 模式 | 触发条件 | 适用 |
|---|---|---|
| 符号链接 | `~/.dsh/profiles/web` 不存在 | **服务器**：profile 完全由仓库提供，极简 |
| 引入 | `~/.dsh/profiles/web` 已是真实目录 | **本地开发机**：个人插件保留，sentry 核心经 include 引入 |

服务器走符号链接模式，见下文。

## 部署五步

```bash
# 0. 基础环境：Node ≥ 22.19、pnpm 11、git，以及 dsh 宿主（npm i -g dsh 或
#    clone deepseek-harness 仓库，二选一）

# 1. 克隆本仓库
git clone <gitlab 地址> ~/dsh-sentry && cd ~/dsh-sentry

# 2. 安装（workspace:* 自动链接全部 sentry 插件到 apps/profile/node_modules）
pnpm install

# 3. 生成环境装配文件（cordis.patch.yml + cordis.include.yml 双格式）
pnpm --filter @dsh-sentry/agent run regenerate

# 4. 接入 dsh：建符号链接 ~/.dsh/profiles/web -> <repo>/apps/profile
pnpm run profile:link

# 5. 启动（GUI 监听 127.0.0.1:3080）
dsh web
```

## 凭据

把本机 `~/.dsh/.credentials.yaml` 用 scp 传到服务器同路径（权限 600）：

```bash
ssh <user>@<server> 'mkdir -p ~/.dsh'
scp ~/.dsh/.credentials.yaml <user>@<server>:~/.dsh/.credentials.yaml
```

所有 token / 账密（ZADIG_API_TOKEN、TAPD_TOKEN、各环境 GreptimeDB/Grafana/dbx/
RocketMQ）都在里面。键名清单以 `apps/agent/envs.yml` 为准。

## 代码检索腿（可选）

`sentry_search_code` 需要服务器上有 novo-commctl 的 clone：

```bash
export DSH_SENTRY_CODE_BASE=/srv/novo-commctl   # 服务器上的 clone 路径（或写入 $DSH_HOME/.credentials.yaml 的同名键）
git clone <novo-commctl 地址> $DSH_SENTRY_CODE_BASE
pnpm --filter @dsh-sentry/agent run regenerate
```

不配置时其他证据腿不受影响，code 腿会以错误证据回报。

## 访问（安全）

GUI 无认证层，**只监听 localhost**。远程访问用 SSH 隧道，不要暴露端口：

```bash
ssh -L 3080:localhost:3080 <user>@<server>
# 然后本地浏览器打开 http://localhost:3080
```

## 常驻运行（systemd 示例）

```ini
[Unit]
Description=dsh-sentry web
After=network.target

[Service]
WorkingDirectory=/home/<user>/dsh-sentry
ExecStart=/usr/bin/dsh web
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 升级流程（顺序不能乱）

```bash
# 1. 停进程（systemctl stop 或 kill；不能热装依赖——会卡死 patch 热重载）
# 2. cd ~/dsh-sentry && git pull && pnpm install
# 3. 环境配置有变时：pnpm --filter @dsh-sentry/agent run regenerate
# 4. 启动进程（systemctl start）
```

## 排错

| 症状 | 检查 |
|---|---|
| 插件全部 401/凭据错误 | 服务器 `~/.dsh/.credentials.yaml` 是否就位、键名是否齐（对照 envs.yml） |
| sentry 工具/技能不存在 | `dsh --profile web --dump-config \| grep sentry-` 看配置树；patch 条目必须在 `- insert:` 列表内 |
| patch 改了不生效 | 进程运行期间跑过 profile 目录的 pnpm install → 重启进程 |
| GUI 打不开 | 确认用 SSH 隧道而非直连；服务端 `curl -s localhost:3080` 自查 |
| 第三方市场插件缺失 | 服务器符号链接模式不装个人插件（by design）；确需则参考本地引入模式手工建 profile 目录后跑 profile:link |

## 本地与服务器的关系（对照）

- 本地（引入模式）：`~/.dsh/profiles/web` 真实目录，个人插件 + include 引入 sentry 核心；
  仓库更新后 `pnpm run profile:link` 重新同步，个人插件不受影响
- 服务器（符号链接模式）：profile 即仓库 `apps/profile`，纯 sentry 核心，无个人插件；
  更新 = git pull + reinstall + 重启

## 变体：本地独立 profile（独立端口，2026-09-02 实测）

本地新人上手的**默认模式**（见 onboarding.md）：sentry 接成独立 profile、独立端口，
与个人 `dsh web`（3080）同时运行：

```bash
# 1. 接入为独立 profile（~/.dsh/profiles/sentry 不存在 → 符号链接模式）
pnpm run profile:link sentry        # 即 node scripts/link-profile.mjs sentry

# 2. 独立端口启动（--port 是 dsh web app 原生参数）
dsh --profile sentry --port 3081    # 打开 http://127.0.0.1:3081
```

特性与注意：

- 凭据、模型配置在 `$DSH_HOME` 级共享（`.credentials.yaml` / `settings.yaml`），
  新 profile 直接复用，不用重配。
- profile 是仓库符号链接 → 纯 sentry 核心，GUI 市场插件装不进去（隔离即目的）。
- 对话内切环境照常工作：切换写入仓库 `apps/profile/cordis.patch.yml`，经符号链接
  即该 profile 的 patch 文件，watcher 热重载生效；web profile 的 include 桩不受影响。
- 预检命令换成对应 profile 名：`dsh --profile sentry --dump-config | grep sentry-`。
- 更新流程同服务器模式：停进程 → git pull → pnpm install →（插件增删时重跑
  `pnpm run profile:link sentry`）→ 重启。
