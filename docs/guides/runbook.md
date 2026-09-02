# DSH 启动与加载手册

dsh-sentry 的插件通过 DSH **profile + patch 叠加层**机制加载。本手册覆盖两种已实测的启动方式：headless（一次性 CLI）和 web（常驻 GUI）。

## 概念速览

| 概念 | 说明 |
|---|---|
| profile | `~/.dsh/profiles/<name>` 下的独立运行单元：自己的 `package.json`（插件依赖）+ `cordis.patch.yml`（用户 patch 层）。profile 之间互不可见。 |
| bundle | profile 的基础插件组合（`dsh-base`、`dsh-web-app`、`dsh-headless` 等），按 `dsh.profile.bundles` 顺序叠加。 |
| patch 层 | 在 bundle 之上的用户修改：`- id: <行id>` 覆盖已有行，`- insert: [...]` 追加新行。sentry 插件就是用 insert 加入的。 |
| link 依赖 | `dsh plugin add <本地路径>` 安装的包是 pnpm link，指向 dsh-sentry 工作区。**改 dsh-sentry 代码后只需重启宿主即生效，不用重装。** |
| 凭据 | `$DSH_HOME/.credentials.yaml`（优先）+ 进程环境变量。插件里写的是引用名（如 `GREPTIMEDB_DP0_USERNAME`），不是明文。 |
| 模型 | 沿用 `$DSH_HOME/settings.yaml`（当前 kimi/k3），sentry 插件不引入自己的模型配置。 |

## 方式一：headless（一次性任务，适合快速验证）

```bash
cd /Users/yangfm/workspace/labs/deepseek-harness

# 首次：初始化 profile 并安装 sentry 插件（只需一次）
pnpm dsh plugin --profile headless add \
  /Users/yangfm/workspace/work/dsh-sentry/packages/core/evidence \
  /Users/yangfm/workspace/work/dsh-sentry/packages/core/datasource \
  /Users/yangfm/workspace/work/dsh-sentry/packages/services/greptimedb \
  /Users/yangfm/workspace/work/dsh-sentry/packages/tools/tool-log-analyzer

# 每次运行：带 sentry 叠加层启动一个一次性会话
pnpm dsh --profile headless \
  --patch /Users/yangfm/workspace/work/dsh-sentry/apps/agent/sentry.cordis.patch.yml \
  "<排查任务>"
```

- 叠加层文件：`apps/agent/sentry.cordis.patch.yml`（本仓库内，可改 endpoint/环境标签）。
- 运行结束自动退出；session 持久化在 `~/.dsh/sessions`。
- 示例任务：「列出近 30 分钟有日志的服务」「查 commctl-config 近 30 分钟的 ERROR 日志模式」。

## 方式二：web（GUI 页面，适合交互排查）

> 现行默认接入方式已改为**独立 sentry profile**（`pnpm run profile:link sentry` → `dsh --profile sentry --port 3090`），见 [onboarding.md](onboarding.md)。本节保留手工往 web profile 装插件的原始步骤，供调试加载机制时参考。

```bash
cd /Users/yangfm/workspace/labs/deepseek-harness

# 首次：安装 sentry 插件到 web profile（只需一次）
pnpm dsh plugin --profile web add \
  /Users/yangfm/workspace/work/dsh-sentry/packages/core/evidence \
  /Users/yangfm/workspace/work/dsh-sentry/packages/core/datasource \
  /Users/yangfm/workspace/work/dsh-sentry/packages/services/greptimedb \
  /Users/yangfm/workspace/work/dsh-sentry/packages/tools/tool-log-analyzer
```

然后把 sentry 行写进 `~/.dsh/profiles/web/cordis.patch.yml`（已配置好，内容如下）：

```yaml
- insert:
    - id: sentry-greptimedb
      name: '@dsh-sentry/service-greptimedb'
      config:
        endpoint: https://greptimedb.cn-0.dev.novo-one.com
        database: public
        usernameRef: GREPTIMEDB_DP0_USERNAME
        passwordRef: GREPTIMEDB_DP0_PASSWORD
    - id: sentry-tool-log-analyzer
      name: '@dsh-sentry/tool-log-analyzer'
      config:
        env: dev-platform-hosted-0
```

```bash
# 预检（不启动服务，打印组合后的完整配置树，grep 验证 sentry 行）
pnpm dsh --dump-config --profile web | grep -A 10 sentry

# 重启 web 服务生效（插件树是启动时加载的）
pnpm dsh web
```

重启后刷新 http://127.0.0.1:3080，**开新对话**（旧对话的上下文不含新工具目录）。

## 凭据配置

真实查询需要把凭据写进 `$DSH_HOME/.credentials.yaml`（或运行前 export 同名环境变量）：

```yaml
GREPTIMEDB_DP0_USERNAME: <用户名>
GREPTIMEDB_DP0_PASSWORD: <密码>
```

引用名以 `apps/agent/envs.yml` 各环境行的 `*Ref` 字段为准（唯一事实来源）；endpoint 不同时改 `envs.yml` 对应行后重新生成。

## 改了 dsh-sentry 代码之后

两个 profile 都是 link 依赖指向本工作区：

1. `pnpm typecheck && pnpm test` 确认本仓库验证通过；
2. 重启对应宿主（headless 每次运行都是新进程，无需额外操作；web 需要重启进程）。

## 常见问题

| 症状 | 原因与处理 |
|---|---|
| 模型说没有 sentry 工具 | web 未重启；或对话是重启前开的旧对话——开新对话。 |
| evidence 报「endpoint 或凭据缺失」 | 凭据引用名在 credentials store 和环境中都没有。检查 `.credentials.yaml` 键名与 patch 里的 `usernameRef`/`passwordRef` 是否一致。 |
| evidence 报 `GreptimeDB HTTP 401` | 凭据本身错了（用户不存在/密码错误），链路是好的。 |
| `pnpm install` 后类型冲突（同一包两份实例） | dsh-* 依赖范围不一致导致 pnpm 双实例。本仓库所有 `@deepseek-ai/dsh-*` 统一用 `^0.1.0-rc.7`，不要单独 pin 某个包。 |
| 想看插件有没有进配置树 | `pnpm dsh --dump-config --profile <name> \| grep sentry`，不启动服务的只读预检。 |

## 当前已加载的 sentry 能力

全部工具与数据源清单见 [README 能力全景](../../README.md#能力全景)（以仓库装配文件 `apps/profile/cordis.include.yml` 为准）。新包加入方式不变：加进根和 `apps/profile` 的 `workspace:*` 依赖 → regenerate → profile:link → 停机安装 → 重启，详见 [onboarding.md](onboarding.md) 日常更新一节。
