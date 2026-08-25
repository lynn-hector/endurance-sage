# 服务器部署指南

dsh-sentry 在远程服务器的部署 = 仓库 + DSH 宿主 + 凭据 三件套。profile 已做成
仓库内 workspace 包（`apps/profile/`），**无需手改任何 link: 路径**。

## 部署四步

```bash
# 1. 基础环境：Node ≥ 22.19、pnpm 11、git；克隆本仓库
git clone <gitlab 地址> ~/dsh-sentry && cd ~/dsh-sentry

# 2. 安装（workspace:* 自动链接全部 sentry 插件到 apps/profile/node_modules）
pnpm install

# 3. 接入 dsh：建符号链接 ~/.dsh/profiles/web -> <repo>/apps/profile
pnpm run profile:link        # 自定义名字：pnpm run profile:link -- <name>

# 4. 启动（DSH 宿主，GUI 监听 127.0.0.1:3080）
dsh web
```

## 凭据

把本机 `~/.dsh/.credentials.yaml` 用 scp 传到服务器同路径（权限 600）：

```bash
scp ~/.dsh/.credentials.yaml <user>@<server>:~/.dsh/.credentials.yaml
```

所有 token / 账密（ZADIG_API_TOKEN、TAPD_TOKEN、各环境 GreptimeDB/Grafana/dbx/
RocketMQ）都在里面。键名清单见 `apps/agent/envs.yml`。

## 代码检索腿（可选）

`sentry_search_code` 需要服务器上有 novo-commctl 的 clone。设置环境变量后重新
生成 patch：

```bash
export DSH_SENTRY_CODE_BASE=/srv/novo-commctl   # 服务器上的 clone 路径
git clone <novo-commctl 地址> $DSH_SENTRY_CODE_BASE
pnpm --filter @dsh-sentry/agent run regenerate
```

不配置时其他证据腿不受影响，code 腿指向不存在的路径会以错误证据回报。

## 访问（安全）

GUI 无认证层，**只监听 localhost**。远程访问用 SSH 隧道，不要暴露端口：

```bash
ssh -L 3080:localhost:3080 <user>@<server>
# 然后本地浏览器打开 http://localhost:3080
```

## 常驻运行

任意进程管理器皆可，关键是**升级时先停进程**：

```bash
# systemd 示例（WorkingDirectory 指向仓库）
[Service]
WorkingDirectory=/home/<user>/dsh-sentry
ExecStart=/usr/bin/dsh web
Restart=on-failure
```

## 升级流程（顺序不能乱）

```bash
# 1. 停进程（不能热装依赖——会卡死 patch 热重载，见 incidents）
# 2. git pull && pnpm install
# 3. pnpm --filter @dsh-sentry/agent run regenerate   # 环境配置有变时
# 4. 重启进程
```

## 排错

| 症状 | 检查 |
|---|---|
| 插件全部 401/凭据错误 | 服务器 `~/.dsh/.credentials.yaml` 是否就位、键名是否齐（对照 envs.yml） |
| 工具不可用 | `dsh --profile web --dump-config` 看配置树是否含 sentry 插件 |
| patch 改了不生效 | 进程运行期间跑过 profile 目录的 pnpm install → 重启进程 |
| GUI 打不开 | 确认用 SSH 隧道而非直连；服务端 `curl -s localhost:3080` 自查 |
