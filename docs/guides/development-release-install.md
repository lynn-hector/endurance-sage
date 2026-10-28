# 开发验证、发布与安装

本文说明功能开发完成后的完整交付路径：先执行验证，再根据使用场景选择本地工作区安装，或通过 GitLab Package Registry 发布并安装版本化 npm 包。

`apps/` 仅用于维护和验证，不会发布。正式发布的用户入口是统一 bundle：`@dsh-sentry/sentry`。

## 一、开发完成后的验证

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run release:pack
```

各命令的职责：

- `verify`：执行类型检查、单元测试、代码加载和声明式 Cordis loader 验证。
- `release:pack`：同步发布元数据，构建全部包，生成 tarball，检查文件内容，并在独立目录中只使用这些 tarball 安装和加载 bundle。

发布产物位于 `output/npm/`，冒烟环境位于 `output/npm-smoke/`。两个目录都被 Git 忽略，不需要提交。

如果修改了 `apps/agent/envs.yml`，先执行：

```bash
pnpm run sync:release
```

该命令同步所有发布包的版本和元数据、包内默认环境矩阵以及 bundle patch。需要同时更新本地 profile 的启动环境时，再执行：

```bash
pnpm --filter @dsh-sentry/agent run regenerate
```

## 二、本地安装与运行

本地安装适用于开发调试、发布前验证，以及尚未发布 npm 版本时使用。它依赖当前仓库的 `workspace:*`，与 GitLab 用户安装是两条不同路径。

### 前置条件

- Node `^22.19.0 || >=24.0.0` 和 pnpm `11.22.0`。
- 已安装 DSH 宿主。
- 已按[凭据管理](credentials.md)准备 `$DSH_HOME/.credentials.yaml`。
- 如果 DSH 正在通过链接运行当前仓库，先停止 DSH，再执行依赖安装或更新。

### 安装并启动

在仓库根目录执行：

```bash
pnpm install
pnpm run build
pnpm run profile:link sentry
```

检查最终装配配置：

```bash
dsh --profile sentry --dump-config
```

正常启动服务：

```bash
dsh --profile sentry --port 3090
```

`profile:link sentry` 将本地 `apps/profile` 链接到 DSH；`dump-config` 只用于检查 bundle 和 patch 合并后的配置，不能证明外部数据源已经连通。

### 本地更新

停止 DSH 后，在仓库根目录执行：

```bash
git pull --ff-only
pnpm install
pnpm run build
```

环境配置或本地默认环境有变化时，再运行 `pnpm --filter @dsh-sentry/agent run regenerate`，然后重新启动 DSH。

## 三、通过 GitLab 发布

以下步骤由维护者执行。所有 `@dsh-sentry/*` 包采用锁步版本，根目录 `package.json` 的 `version` 是唯一手工维护的版本号。

### 准备 GitLab

确认项目的 **Deploy → Package Registry** 可用，并在 **Settings → CI/CD → Variables** 中配置：

- `NODE_AUTH_TOKEN`：具有 `api` 权限的 GitLab token，用于发布；启用 Masked，并按项目保护策略启用 Protected。
- `DSH_SENTRY_NPM_REGISTRY`：可选。通常不配置，CI 默认使用 `CI_PROJECT_ID` 对应的当前项目 Package Registry。

### 创建发版提交

功能代码合并后，建议使用单独的发版提交：

1. 只修改根目录 `package.json` 的 `version`，不要逐包修改。
2. 执行发布前检查：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run sync:release
   pnpm run verify
   pnpm run release:pack
   ```

3. 提交版本变化、发布元数据和同步后的生成物，并合并到默认分支。

### 创建标签并发布

在合并后的提交上创建标签。标签必须为 `v<version>`，例如根版本 `0.1.0` 对应：

```bash
git tag -a v0.1.0 -m "release v0.1.0"
git push origin v0.1.0
```

标签流水线依次执行：

1. `verify`：检查生成物一致性，运行完整验证和打包，保存 `output/npm/`。
2. `publish-npm`：校验标签与版本一致，复用同一批已验证 tarball 发布，不重新构建。

发布后，在项目 **Deploy → Package Registry** 中确认所有包及版本。版本不可覆盖；发现问题时应修复、提升版本并发布新标签，不要重复发布同一版本。

## 四、通过 GitLab 安装与升级

以下步骤由使用者执行，不需要克隆 dsh-sentry 仓库，也不需要运行仓库的 `pnpm install`、`build` 或 `regenerate`。

### 配置 registry 和只读凭据

将以下内容写入安装机器的 `.npmrc`，把 `<项目ID>` 替换为 GitLab 项目首页显示的数字 ID：

```ini
@dsh-sentry:registry=https://gitlab.yeastar.com/api/v4/projects/<项目ID>/packages/npm/
//gitlab.yeastar.com/api/v4/projects/<项目ID>/packages/npm/:_authToken=${GITLAB_TOKEN}
```

`GITLAB_TOKEN` 用于读取软件包，按项目权限要求使用具有 `read_api` 或 Package Registry 读取权限的 token。发布用的 `NODE_AUTH_TOKEN` 不需要分发给普通用户。

### 安装指定版本

在已有 DSH profile 中执行：

```bash
dsh plugin --profile sentry add @dsh-sentry/sentry@<version>
dsh --profile sentry --dump-config
dsh --profile sentry --port 3090
```

默认环境矩阵随包安装，真实数据源凭据仍需按[凭据管理](credentials.md)在本机配置。

### 升级版本

停止正在运行的 DSH，使用同一命令指定新版本：

```bash
dsh plugin --profile sentry add @dsh-sentry/sentry@<new-version>
dsh --profile sentry --dump-config
```

确认配置无误后再启动服务。升级不需要重新维护任何 `apps/` 文件。

## 五、相关文档

- `apps/` 中各目录和文件的职责：[apps/README.md](../../apps/README.md)。
- 环境切换：[env-switching.md](env-switching.md)。
- 凭据配置：[credentials.md](credentials.md)。
- 服务器部署背景：[deploy.md](deploy.md)。
