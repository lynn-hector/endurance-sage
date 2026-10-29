# DSH 启动与加载手册

dsh-sentry 通过 DSH profile 加载统一的 `@dsh-sentry/sentry` bundle。本文只描述当前的 headless 一次性任务和 Web 常驻服务；安装、升级与发布命令见[开发验证、发布与安装](development-release-install.md)。

## 概念速览

- **profile**：`~/.dsh/profiles/<name>` 下的独立运行单元，保存插件依赖和 `cordis.patch.yml`。不同 profile 的插件互不可见。
- **统一 bundle**：`@dsh-sentry/sentry` 负责加载全部 sentry 插件。用户只需安装这一个包，不再逐条安装 evidence、datasource、service 和 tool。
- **patch 层**：在 bundle 之上覆盖配置。sentry 默认只有一个 `id: sentry` 的装配入口，`defaultEnv` 在这里覆盖，表示装配环境；本机偏好 `DSH_SENTRY_DEFAULT_ENV` 未设置或失效时，它才作为新 Session 默认环境。
- **凭据**：`$DSH_HOME/.credentials.yaml` 或进程环境变量保存真实值；插件配置只包含 `*Ref` 引用名。
- **模型**：沿用 `$DSH_HOME/settings.yaml`，sentry bundle 不引入自己的模型配置。

本地 `apps/profile` 还声明了 Web、IM 等开发用宿主 bundle；npm 包 `@dsh-sentry/sentry` 只包含 sentry 能力，不强制安装 GUI 或 IM。

## 方式一：headless 一次性任务

适用于快速检查工具、执行单次排查或接入自动化任务。

### 使用 GitLab 版本

在已经初始化的 headless profile 中安装统一 bundle：

```bash
dsh plugin --profile headless add @dsh-sentry/sentry@<version>
```

执行一次性任务：

```bash
dsh --profile headless "列出近 30 分钟有日志的服务"
dsh --profile headless "查 commctl-config 近 30 分钟的 ERROR 日志模式"
```

运行结束后进程退出，Session 按 DSH 宿主机制持久化。

### 使用本地工作区

先按[本地安装流程](development-release-install.md#二本地安装与运行)完成构建和 `profile:link sentry`，然后执行：

```bash
dsh --profile sentry "列出所有环境"
dsh --profile sentry "查 commctl-config 近 30 分钟的 ERROR 日志模式"
```

## 方式二：Web 常驻服务

无论通过 GitLab 还是本地工作区安装，完成装配后都使用相同的启动方式：

```bash
# 输出 bundle 与 patch 合并后的最终配置，做启动前检查
dsh --profile sentry --dump-config

# 启动 Web GUI
dsh --profile sentry --port 3090
```

打开 `http://127.0.0.1:3090`，安装或升级插件后应**新建对话**再验证工具。旧对话的上下文不会自动获得新的工具目录。

可以过滤统一 bundle 的配置入口：

```bash
dsh --profile sentry --dump-config | grep -A 12 'sentry'
```

`dump-config` 只验证安装和配置装配，不验证 GreptimeDB、Zadig 等外部数据源的连通性。

## 凭据配置

真实查询需要把凭据写入 `$DSH_HOME/.credentials.yaml`，或在运行前 export 同名环境变量。例如：

```yaml
GREPTIMEDB_DP0_USERNAME: <用户名>
GREPTIMEDB_DP0_PASSWORD: <密码>
```

引用名以 `apps/agent/envs.yml` 中各环境的 `*Ref` 字段为准。npm 安装用户获得的是包内默认矩阵，通常只需补本机凭据；详细规则见[凭据管理](credentials.md)。

## 修改本地源码之后

当前发布包从 `dist` 加载，不是直接加载 TypeScript 源码。本地链接开发时，修改代码后应执行：

```bash
pnpm run build
pnpm run verify
```

然后重启 Web 宿主。headless 每次运行都会创建新进程，但也必须先完成构建。只修改源码而不构建，可能继续加载旧的 `dist` 文件。

## 常见问题

- **模型说没有 sentry 工具**：确认已安装统一 bundle、重启宿主，并新建对话；再用 `dump-config` 检查 profile。
- **提示 endpoint 或凭据缺失**：检查 `.credentials.yaml` 的键名是否与矩阵中的 `*Ref` 完全一致。
- **返回 HTTP 401**：配置链路已经到达服务端，优先检查凭据值和账号权限。
- **依赖或类型冲突**：不要单独固定某个 `@deepseek-ai/dsh-*` 版本；当前仓库统一使用 `0.2.1-rc.3` 版本线。
- **本地修改没有生效**：确认已执行 `pnpm run build` 并重启宿主。
- **插件管理页面里 sentry 条目只有包名、没有标题/描述/图标**：宿主从 `packages/bundle/sentry` 的 `locale/{en,zh}.json` 与 manifest `icon` 读取展示元数据，且要求包导出 `./locale/*.json`、`./package.json`；先跑 `node scripts/sync-release.ts` 确认清单，再重启宿主（运行中进程不重新解析包）。
- **重复注册插件**：不要同时保留旧的逐插件 patch 和新的统一 bundle；移除旧条目后再启动。

## 当前能力的事实来源

工具与数据源清单见 [README 能力全景](../../README.md#能力全景)。实际加载集合由 `packages/bundle/sentry` 和 `renderEntries()` 决定，`apps/profile/cordis.include.yml` 只是本地 profile 的生成装配壳，不再维护逐插件清单。
