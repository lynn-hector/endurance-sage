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

`sentry_search_code` 覆盖 GitLab `novoone/backend` 组全部仓库。服务器上用仓库自带的引导脚本一次拉全（浅克隆；日常更新由 `sentry_sync_code` 的 ff-only pull 负责）：

```bash
pnpm --filter @dsh-sentry/agent run clone-repos -- --target /srv/novoone-backend
# 目标也可走 DSH_SENTRY_CODE_BASE（环境变量 / $DSH_HOME/.credentials.yaml 同名键），脚本会自动解析。
# 检出根目录不需要 regenerate 传递：机器路径不进装配，服务构造期按
# envs.yml 行内值 > 环境变量 > 凭据库 解析。手工启动可在当前 shell export：
export DSH_SENTRY_CODE_BASE=/srv/novoone-backend
# systemd 不继承这个 shell；常驻部署必须在 unit 的 [Service] 中配置同名 Environment=。
# 环境变量会覆盖从本地 scp 带来的凭据库旧路径。
```

装有 codegraph 的服务器上，clone 脚本会自动初始化各仓索引（老检出无索引会补建）；未装则检索回退 ripgrep。

**GitLab 认证（clone 与后续 pull 共用）**：私有仓二选一——HTTPS + PAT（默认）或 SSH key（脚本加 `--ssh`）。配置步骤唯一权威源是 [onboarding.md](onboarding.md) 第 2 步「GitLab 认证」（含无终端交互环境的预置做法）；配置一次后 `sentry_sync_code` 的 pull 同样免密。

不配置时其他证据腿不受影响，code 腿会以错误证据回报。

## 访问（安全）

GUI 无认证层，**只监听 localhost**。远程访问用 SSH 隧道，不要暴露端口：

```bash
ssh -L 3080:localhost:3080 <user>@<server>
# 然后本地浏览器打开 http://localhost:3080
```

## 常驻运行（systemd 服务，Ubuntu）

把 sentry profile 做成系统服务：开机自启、崩溃自动重启、日志进 journald。
**前置**：部署五步已完成，手工跑 `dsh --profile sentry --port 3090` 确认正常，
且 `~/.dsh/.credentials.yaml` 已就位。

### 1. 确认路径

```bash
which dsh        # 记下绝对路径，全局 npm 安装通常是 /usr/local/bin/dsh 或 /usr/bin/dsh
which node       # dsh 是纯 Node CLI，systemd 的默认 PATH 里没有用户级 node（nvm 等）时需特别处理
```

### 2. 创建服务单元

`sudoedit /etc/systemd/system/dsh-sentry.service`：

```ini
[Unit]
Description=dsh-sentry sentry profile (port 3090)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<user>
Environment=DSH_HOME=/home/<user>/.dsh
Environment=DSH_TELEMETRY_DISABLED=1
# 可选代码检索腿：使用机器路径时显式注入，不继承交互 shell 的 export
Environment=DSH_SENTRY_CODE_BASE=/srv/novoone-backend
WorkingDirectory=/home/<user>/dsh-sentry
ExecStart=/usr/local/bin/dsh --profile sentry --port 3090
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

字段说明：

| 字段 | 说明 |
|---|---|
| `User` | **必须**是部署时的普通用户——凭据在 `/home/<user>/.dsh/`，跑成 root 会读不到 |
| `DSH_HOME` | 显式指向该用户的 `~/.dsh`，避免 systemd 环境下 `$HOME` 解析差异 |
| `DSH_SENTRY_CODE_BASE` | 可选代码检索腿的检出根目录；不启用该腿可删除此行。修改后 `daemon-reload` 并重启服务，无需 regenerate |
| `ExecStart` | `which dsh` 的实际输出；**不能用** `~` 或 `$HOME` |
| `WorkingDirectory` | 约定非依赖：dsh 解析 profile/凭据全走 `DSH_HOME`，不用 cwd。写仓库目录只为与更新流程（git pull 所在处）对齐、给潜在的相对路径落盘一个可预期位置，改成 `/home/<user>` 亦可 |
| `Restart=always` + `RestartSec=5` | 崩溃 5 秒后自动拉起；日常更新流程本身就要停进程，不受它干扰 |
| `After/Wants=network-online.target` | 所有证据腿都是 HTTPS 出网调用，等网络就绪再启动 |

**node 不在系统 PATH 的情况**（node 装在 nvm/fnm 等用户级目录时）：`dsh` shim 找不到 node 会直接退出、服务反复重启。改用显式 node 路径写 ExecStart：

```ini
ExecStart=/home/<user>/.nvm/versions/node/v24.x.x/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile sentry --port 3090
```

### 3. 启用并验证

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-sentry     # 启动 + 开机自启
systemctl status dsh-sentry                # active (running) 即成功
journalctl -u dsh-sentry -f                # 实时日志（Ctrl+C 退出查看，不影响服务）
curl -s localhost:3090 >/dev/null && echo ok   # 服务侧端口自查
```

### 4. 远程访问

与手工启动相同——GUI 无认证层，只监听 localhost，用 SSH 隧道（注意端口换成 3090）：

```bash
ssh -L 3090:localhost:3090 <user>@<server>
# 本地浏览器打开 http://localhost:3090
```

### 5. 日常更新（配合 systemd）

更新流程不变，只是停/启换成 systemctl：

```bash
sudo systemctl stop dsh-sentry
cd ~/dsh-sentry && git pull && pnpm install
# envs.yml 有变动时：pnpm --filter @dsh-sentry/agent run regenerate
sudo systemctl start dsh-sentry
```

`sudo systemctl restart dsh-sentry` 等价但会跳过上面 2、3 步，只用于改了 unit 文件
（改完还需 `sudo systemctl daemon-reload`）。

### 6. 排错

| 症状 | 检查 |
|---|---|
| `systemctl status` 显示反复 restart | `journalctl -u dsh-sentry -n 50 --no-pager` 看退出原因；最常见是 node 路径问题（见上文） |
| 服务起来了但插件全部凭据错误 | `User=` 或 `DSH_HOME=` 指向错了，`journalctl` 里确认读的是 `/home/<user>/.dsh/.credentials.yaml` |
| 3090 端口被占用 | 有手工启动的 dsh 没停：`pgrep -af 'dsh.*3090'`，杀掉后 `systemctl restart dsh-sentry` |
| 浏览器连不上 | 隧道端口打成了 3080——sentry profile 在 3090 |

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
dsh --profile sentry --port 3090    # 打开 http://127.0.0.1:3090
```

特性与注意：

- 凭据、模型配置在 `$DSH_HOME` 级共享（`.credentials.yaml` / `settings.yaml`），
  新 profile 直接复用，不用重配。
- profile 是仓库符号链接 → 纯 sentry 核心，GUI 市场插件装不进去（隔离即目的）。
- 对话内切环境照常工作：`sentry_env_switch` 只更新当前 Session 的持久化绑定，不写仓库装配文件，也不影响 web profile 或其他 Session。
- 预检命令换成对应 profile 名：`dsh --profile sentry --dump-config | grep sentry-`。
- 更新流程同服务器模式：停进程 → git pull → pnpm install →（插件增删时重跑
  `pnpm run profile:link sentry`）→ 重启。
