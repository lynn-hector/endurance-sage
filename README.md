# dsh-sentry

endurance-sentry 的 Cordis 插件化重构仓库：以 DSH（deepseek-harness）原生 Cordis 插件模式，把原项目的 AIOps 能力包（8 个 skill + 共享库 + 模板 + 方法论）重写为有生命周期、有依赖注入、配置带 schema 校验的 TypeScript 插件体系。

重构计划与现状评估见 [`docs/refactor-plan.md`](docs/refactor-plan.md)。

## 当前状态：Phase 0 已完成

monorepo 骨架已搭好，插件注册双路径已验证：

```bash
pnpm install

# 程序化宿主：Context + SystemPrompt + ToolRuntime + SkillRegistry + 探针插件
pnpm dev

# 声明式宿主：通过 cordis.yml + loader 加载同一棵插件树
pnpm dev:loader
```

两条路径都会断言探针工具 `sentry_hello` 和探针 skill `sentry-hello` 注册成功，失败时以非零码退出。

## 目录结构

```text
dsh-sentry/
├── docs/                  # 重构计划与设计文档
├── apps/
│   └── dev/               # Phase 0 开发宿主（程序化 + cordis.yml 两种启动方式）
└── packages/
    └── tools/
        └── tool-hello/    # Phase 0 探针插件（验证用，后续被真实工具替代）
```

## 依赖约定

- `@deepseek-ai/cordis` 及其 loader/include 插件使用 npm 正式版（cordis ^4.0.1、loader ^1.0.2、include ^1.0.6）；
- `@deepseek-ai/dsh-*` 包统一使用 `^0.1.0-rc.7` 范围（实际解析到 0.1.0-rc.8）——必须所有包同一范围，否则 pnpm 会按 peer 上下文装出两份实例，nominal 品牌类型相互不兼容；
- 运行环境 Node ≥ 22.19，包管理 pnpm 11。

## 验证

```bash
pnpm install
pnpm typecheck   # 全部包类型检查
pnpm test        # vitest（含 SQL golden tests，逐字对齐原 SKILL.md 示例）
pnpm dev         # 程序化宿主：断言工具/skill 注册
pnpm dev:loader  # 声明式宿主：cordis.yml + loader 断言同一结果
```

## 通过 DSH 启动（已实测）

插件以 profile patch 叠加层挂进 DSH（deepseek-harness checkout 根目录执行）：

```bash
# 1. 安装 sentry 插件到 profile（link 依赖，一次即可；headless 首次使用会自动初始化）
pnpm dsh plugin --profile headless add \
  /Users/yangfm/workspace/work/dsh-sentry/packages/core/evidence \
  /Users/yangfm/workspace/work/dsh-sentry/packages/core/datasource \
  /Users/yangfm/workspace/work/dsh-sentry/packages/services/greptimedb \
  /Users/yangfm/workspace/work/dsh-sentry/packages/tools/tool-log-analyzer

# 2. 带 sentry 叠加层启动一次性任务会话
pnpm dsh --profile headless \
  --patch /Users/yangfm/workspace/work/dsh-sentry/apps/agent/sentry.cordis.patch.yml \
  "调用 sentry_list_log_services，把 evidence 结果原样告诉我"
```

叠加层文件：`apps/agent/sentry.cordis.patch.yml`。模型/凭据沿用 `$DSH_HOME` 的 settings 与 credentials（当前为 kimi/k3）。

已实测验证的链路：profile 启动 → 模型发现并调用 `sentry_*` 工具 → SQL 生成 → 凭据解析（环境变量/`$DSH_HOME/.credentials.yaml`）→ HTTP 到达真实 GreptimeDB（401 无效凭据被正确包装为 `confidence=0` 的错误 evidence）。

**让查询真正成功**：把真实凭据注入 `GREPTIMEDB_LOCAL_USERNAME` / `GREPTIMEDB_LOCAL_PASSWORD`（写进 `$DSH_HOME/.credentials.yaml`，或运行前 export）；endpoint 不同时改 patch 文件或对应 settings section。
