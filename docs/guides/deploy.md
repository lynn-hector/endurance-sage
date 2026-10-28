# 服务器部署指南

服务器推荐部署由 **DSH 宿主 + GitLab 版本化 sentry bundle + 本机凭据**组成。长期运行使用固定版本，不依赖服务器上的 dsh-sentry Git 工作区。仓库链接方式仅保留给开发调试和应急回退。

## 一、使用 GitLab 版本部署

### 前置条件

- Node `^22.19.0 || >=24.0.0` 和 DSH 宿主。
- 已创建包含 DSH base 与 Web 能力的 `sentry` profile。
- 可读取 dsh-sentry 项目 Package Registry 的 GitLab token。
- 已准备 `$DSH_HOME/.credentials.yaml`。

### 配置 registry

将以下内容写入部署用户的 `.npmrc`，替换 `<项目ID>`：

```ini
@dsh-sentry:registry=https://gitlab.yeastar.com/api/v4/projects/<项目ID>/packages/npm/
//gitlab.yeastar.com/api/v4/projects/<项目ID>/packages/npm/:_authToken=${GITLAB_TOKEN}
```

确保运行 `dsh plugin` 的部署用户能读取该 token，不要把发布用 token 写入仓库或 systemd 单元。

### 安装固定版本

停止已有 DSH 进程，然后执行：

```bash
dsh plugin --profile sentry add @dsh-sentry/sentry@<version>
dsh --profile sentry --dump-config
dsh --profile sentry --port 3090
```

手工确认正常后，再配置 systemd 常驻运行。升级时只需将 `<version>` 替换为新版本，不需要 `git pull` 或 `regenerate`。

## 二、本地仓库回退部署

开发调试或 npm 版本尚未发布时，可使用仓库工作区：

```bash
git clone https://gitlab.yeastar.com/yeastar/infrastructure/golang/endurance/dsh-sentry.git ~/dsh-sentry
cd ~/dsh-sentry
pnpm install
pnpm run build
pnpm --filter @dsh-sentry/agent run regenerate
pnpm run profile:link sentry
dsh --profile sentry --port 3090
```

停止 DSH 后再执行依赖安装或更新。该方式的更新流程为：

```bash
cd ~/dsh-sentry
git pull --ff-only
pnpm install
pnpm run build
# envs.yml 或本地默认环境有变化时：
pnpm --filter @dsh-sentry/agent run regenerate
```

完成后重新启动 DSH。

## 三、凭据与代码检索

将本机凭据安全复制到服务器相同路径，并限制权限：

```bash
ssh <user>@<server> 'mkdir -p ~/.dsh'
scp ~/.dsh/.credentials.yaml <user>@<server>:~/.dsh/.credentials.yaml
ssh <user>@<server> 'chmod 600 ~/.dsh/.credentials.yaml'
```

键名以 `apps/agent/envs.yml` 中的 `*Ref` 为准。不要把真实 token 写入 npm 配置仓库、Git 仓库或本文档。

代码检索腿是可选能力。服务器需要准备业务代码检出，并设置：

```bash
export DSH_SENTRY_CODE_BASE=/srv/novoone-backend
```

维护者可以使用仓库中的 `clone-repos` 引导脚本准备代码。常驻运行时在 systemd 单元中显式设置该环境变量，不要依赖交互 shell 的 `export`。详细认证和路径优先级见[新同事上手指南](onboarding.md#第-4-步可选的代码检索腿)。

## 四、访问安全

GUI 没有独立认证层，只监听 localhost。远程访问使用 SSH 隧道，不要直接暴露端口：

```bash
ssh -L 3090:localhost:3090 <user>@<server>
```

然后在本地浏览器打开 `http://localhost:3090`。

## 五、systemd 常驻运行

先手工完成安装并确认 `dsh --profile sentry --port 3090` 正常，再创建服务。

### 确认可执行文件路径

```bash
which dsh
which node
```

如果 Node 安装在 nvm、fnm 等用户目录中，systemd 可能找不到 node，需要在 `ExecStart` 中使用显式 Node 路径。

### 创建服务单元

执行 `sudoedit /etc/systemd/system/dsh-sentry.service`：

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
# 可选代码检索腿；不使用可删除
Environment=DSH_SENTRY_CODE_BASE=/srv/novoone-backend
WorkingDirectory=/home/<user>
ExecStart=/usr/local/bin/dsh --profile sentry --port 3090
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

关键字段：

- `User`：必须是安装 profile 和凭据的普通用户，不要使用 root。
- `DSH_HOME`：显式指向该用户的 `.dsh`，避免 systemd 环境差异。
- `WorkingDirectory`：npm 部署不依赖 Git 仓库，使用用户主目录即可。
- `ExecStart`：使用 `which dsh` 的实际绝对路径，不能使用 `~` 或 `$HOME`。
- `DSH_SENTRY_CODE_BASE`：仅代码检索腿需要，修改后执行 daemon-reload 并重启。

Node 不在系统 PATH 时，可使用显式路径：

```ini
ExecStart=/home/<user>/.nvm/versions/node/v24.x.x/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile sentry --port 3090
```

### 启用并检查

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-sentry
systemctl status dsh-sentry
journalctl -u dsh-sentry -f
curl -s localhost:3090 >/dev/null && echo ok
```

## 六、常驻服务升级

### GitLab 版本

```bash
sudo systemctl stop dsh-sentry
dsh plugin --profile sentry add @dsh-sentry/sentry@<new-version>
dsh --profile sentry --dump-config
sudo systemctl start dsh-sentry
```

### 本地仓库回退版本

```bash
sudo systemctl stop dsh-sentry
cd ~/dsh-sentry
git pull --ff-only
pnpm install
pnpm run build
# 环境装配有变化时执行 regenerate
sudo systemctl start dsh-sentry
```

只修改 systemd 单元时，执行 `sudo systemctl daemon-reload` 和 `sudo systemctl restart dsh-sentry` 即可，不需要重新安装 bundle。

## 七、排错

- **服务反复重启**：用 `journalctl -u dsh-sentry -n 50 --no-pager` 查看退出原因，优先检查 Node 和 dsh 的绝对路径。
- **所有工具都报凭据错误**：检查 `User`、`DSH_HOME` 和 `.credentials.yaml` 权限及键名。
- **sentry 工具不存在**：运行 `dsh --profile sentry --dump-config | grep -A 12 sentry`，确认统一 bundle 已安装且没有旧 patch 冲突。
- **3090 端口被占用**：检查是否有手工启动的 DSH 进程未停止。
- **浏览器无法访问**：确认使用 SSH 隧道，不要直接访问服务器开放端口。
- **本地源码更新不生效**：执行 `pnpm run build` 后再启动，当前包从 `dist` 加载。

版本发布和用户安装的完整命令见[开发验证、发布与安装](development-release-install.md)。
