# apps 目录说明

`apps` 是维护者的开发、配置和验证工作区。这里的 package 均保持 `private`，不会发布到 GitLab Package Registry，也不会进入 `@dsh-sentry/sentry` 的 npm 安装产物。

`packages/` 保存实际发布的插件和统一 bundle，`apps/` 保存这些插件的使用方式与验证壳，`scripts/` 保存构建和发版工具。

## apps/agent

环境配置源与维护命令所在目录。

- `envs.yml`：唯一手工维护的环境矩阵。新增环境、修改 endpoint、服务发现或 `*Ref` 凭据引用时编辑此文件；真实凭据不保存在这里。
- `src/render.ts`：重新导出 `@dsh-sentry/env-matrix` 的矩阵解析与装配渲染能力，供 agent 命令复用。
- `src/use-env.ts`：环境查看、启动装配生成和默认环境切换 CLI。它不改变已有 Session 的运行期绑定。
- `src/clone-repos.ts`：按环境矩阵中的代码仓库配置，引导克隆或更新本机业务代码检出。
- `tests/`：环境矩阵、装配渲染、依赖方向和维护命令相关测试。
- `package.json`：声明上述 CLI 的 `use-env`、`regenerate` 和 `clone-repos` 等脚本。

`packages/core/env-matrix/envs.yml` 是发布时从 `apps/agent/envs.yml` 同步的副本，不是第二份手工配置源。

## apps/dev

不依赖正式部署 profile 的开发宿主与集成探针。

- `src/bin.ts`：通过代码加载统一 `@dsh-sentry/sentry` bundle，检查插件树和资源配置。
- `src/bin-loader.ts`：通过声明式 Cordis loader 启动，验证配置文件加载链路。
- `cordis.yml`：`bin-loader.ts` 使用的声明式装配配置。
- `src/probe-session-env.ts`：验证 Session 环境绑定、恢复与隔离。
- `src/` 下其他 probe：按数据源或运行场景执行针对性连通性和行为检查。
- `package.json`：声明开发宿主依赖以及 `start`、`start:loader`、probe 脚本。

该目录服务于集成验证，不是面向最终用户的独立应用。

## apps/profile

本地 DSH profile 的装配壳，通过 `workspace:*` 消费与发布版相同的统一 bundle。

- `package.json`：声明本地 profile 所需的 DSH base、Web、IM、context 和 `@dsh-sentry/sentry` bundle。
- `cordis.patch.yml`：本地独立 profile 使用的生成装配文件。
- `cordis.include.yml`：将 sentry 引入已有 profile 时使用的生成装配文件。
- 该目录不包含另一份逐插件维护的 sentry 清单；插件集合由 `packages/bundle/sentry` 统一决定。

`apps/profile` 仅用于本地开发和旧部署方式迁移。GitLab 安装用户不需要此目录。

## 生成物边界

以下文件由命令生成或同步，不应脱离源文件单独修改：

- `packages/core/env-matrix/envs.yml`：来自 `apps/agent/envs.yml`。
- `packages/bundle/sentry/cordis.patch.yml`：统一 bundle 默认装配。
- `apps/profile/cordis.patch.yml` 和 `cordis.include.yml`：本地 profile 装配。

开发完成后的验证、本地安装、GitLab 发布和用户安装步骤统一见[开发验证、发布与安装](../docs/guides/development-release-install.md)。
