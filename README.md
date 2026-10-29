# dsh-sentry

通信产品（novo-commctl）的 AIOps 故障调查员：基于 DSH（deepseek-harness）原生 Cordis 插件体系构建，通过日志、链路、信令、指标、数据库、Redis、MQ、CI/CD、缺陷单和代码等证据，完成「现象 → 验证 → 根因 → 建议」的排查闭环。

本仓库是被 DSH 装配运行的插件集，不包含 DSH 宿主、自带前端或被调查的产品环境。Web GUI、headless CLI 和 IM 入口由宿主及其 bundle 提供。

## 能力全景

| 证据腿 | 工具 | 说明 |
|---|---|---|
| 日志 | `sentry_query_logs` / `sentry_list_log_services` | GreptimeDB k8s 容器日志、服务发现与异常模式提取 |
| 链路 | `sentry_fetch_trace` | Grafana Jaeger 按 traceId 追踪，识别慢调用和错误调用 |
| 信令 | `sentry_query_call_flow` | GreptimeDB `hep_1` SIP 信令时序、里程碑、PDD 与错误响应，支持桥接日志和链路 |
| 指标 | `sentry_query_metrics` / `sentry_list_metrics` | Prometheus range / instant 查询与可用指标名发现 |
| 告警 | `sentry_list_alerts` / `sentry_get_alert_rule` / `sentry_list_am_alerts` / `sentry_list_am_silences` | Prometheus 告警与规则、Alertmanager 告警实例和静默 |
| 数据库 | `sentry_query_db` | 通过 dbx 执行必要、可控的 PostgreSQL 只读 SQL |
| Redis | `sentry_query_redis` | 单个 key 的值、TTL 与类型查询 |
| MQ | `sentry_query_mq` | RocketMQ 消息记录、详情与消费轨迹；消息数量不等于消费积压 |
| CI/CD | `sentry_query_zadig` | Zadig 服务状态、镜像版本、最近部署与工作流历史 |
| K8s | `sentry_query_k8s_pods` / `sentry_read_k8s_pod_logs` / `sentry_list_k8s_events` / `sentry_query_k8s_resource` / `sentry_top_k8s_pods` / `sentry_top_k8s_nodes` / `sentry_list_k8s_namespaces` / `sentry_read_k8s_node_logs` / `sentry_read_k8s_node_stats` | 经 kubernetes-mcp-server 网关的只读集群视图：Pod 状态、容器日志、事件、任意资源对象、Pod/节点资源用量、命名空间与节点日志/统计；集群随 Session 环境自动路由 |
| 缺陷单 | `sentry_query_tapd` | TAPD 候选已知缺陷与修复状态对账 |
| 代码 | `sentry_search_code` / `sentry_read_code` / `sentry_sync_code` | 跨仓代码检索与读取；按需 ff-only 同步配置内仓库并维护 codegraph 索引 |
| 环境 | `sentry_env_list` / `sentry_env_current` / `sentry_env_switch` | 查看和切换当前 Session 的环境绑定，不影响其他 Session |

`packages/skills` 提供全局 persona、可按复杂度裁剪的排查方法论、工具使用边界和结构化输出模板。`git-guard` 提供危险 git 命令的双层门禁（[设计文档](docs/architecture/git-guard.md)）。

工具输出统一使用 `{ evidence: {...} }` 信封，执行失败也保留错误证据。默认只读，不执行改变线上状态的操作；代码同步只更新本机检出，环境切换只更新当前 Session 绑定。

## 目录结构

```text
dsh-sentry/
├── apps/                         # 应用装配与验证：怎么把插件用起来
│   ├── agent/                    # 环境矩阵、profile 生成、默认环境与仓库引导
│   │   ├── envs.yml              # 环境配置的唯一手工维护点
│   │   └── src/                  # render / use-env / clone-repos
│   ├── profile/                  # 交给 DSH 宿主加载的可部署 profile
│   │   ├── package.json          # bundle 与 sentry 插件依赖清单
│   │   ├── cordis.patch.yml      # 生成物：独立 sentry profile 的 patch
│   │   └── cordis.include.yml    # 生成物：引入已有个人 profile 的 patch
│   └── dev/                      # 开发宿主与探针，不是主要业务源码目录
│       └── src/                  # 注册断言、声明式加载、单腿连通性与 Session 环境验证
├── packages/                     # 插件零件：真正干活的代码
│   ├── core/                     # evidence、环境契约、数据源接口与共享基础设施
│   ├── services/                 # 外部数据源实现：认证、请求、解析与 Provider 路由
│   ├── tools/                    # 面向模型的 sentry_* 工具：参数、调用与 evidence 输出
│   ├── skills/                   # 全局 persona、按需 skill 与 references
│   └── guard/                    # git-guard 安全门禁
├── docs/                         # 架构、操作手册、对接与事件档案
├── scripts/                      # 仓库级辅助脚本，如 profile 链接与引入
├── package.json                  # workspace 常用命令
└── pnpm-workspace.yaml           # pnpm workspace 包发现配置
```

**apps 与 packages 的关系**：`packages` 是零件，`apps` 是用法。`agent` 按环境配置生成装配，`profile` 交给 DSH 加载，`dev` 在正式装配前验证零件和加载链路。各目录与文件职责见 [apps/README.md](apps/README.md)。

一次查询通常经过：

```text
profile 装配 → skills 选择方法 → tools 接收参数
→ core 接口 → env-provider 确定 Session 环境 → services 查询外部数据源
→ tools 返回 evidence
```

## 快速上手

环境要求：Node `^22.19.0 || >=24.0.0`，pnpm `11.22.0`。实际运行还需要安装 DSH 宿主并准备本机凭据，见[启动手册](docs/guides/runbook.md)和[凭据管理](docs/guides/credentials.md)。

```bash
pnpm install
pnpm typecheck   # 全部包类型检查
pnpm test        # Vitest 单元与装配测试
pnpm verify      # typecheck + test + 两种 apps/dev 加载检查
```

常用开发与装配命令：

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 通过代码挂载插件，检查工具、persona 和 skills 注册 |
| `pnpm dev:loader` | 通过声明式 Cordis 配置验证加载链路 |
| `pnpm --filter @dsh-sentry/dev exec tsx src/probe.ts zadig TP0` | 对指定数据腿和环境执行一次无害只读连通性检查 |
| `pnpm --filter @dsh-sentry/dev run probe:session-env` | 验证 Session 环境绑定、恢复与隔离 |
| `pnpm --filter @dsh-sentry/agent run regenerate` | 从 `apps/agent/envs.yml` 重新生成 profile patch |
| `pnpm run profile:link` | 将 `apps/profile` 链接或引入本机 DSH profile |

启动与挂载（headless CLI / Web GUI）：[docs/guides/runbook.md](docs/guides/runbook.md)。多环境切换：[docs/guides/env-switching.md](docs/guides/env-switching.md)。

## 修改代码时去哪里

- 修改环境或数据源装配：`apps/agent/envs.yml`，然后重新生成；不要直接维护生成物。
- 修改模型工具参数或返回结构：`packages/tools`，并同步对应 skill 的工具契约。
- 修改外部请求、认证或响应解析：`packages/services`。
- 修改 tools 与 services 之间的接口：`packages/core` 中对应的 `*-store`。
- 修改系统行为、触发条件或排查方法：`packages/skills`。
- 修改后先用单元测试和 `apps/dev` 验证，再交给 `apps/profile` 运行。

## 关键约定

- **凭据只引用不落值**：`apps/agent/envs.yml` 只写 `*Ref` 键名，实际值存于本机 `$DSH_HOME/.credentials.yaml`。
- **生成物不回改**：`cordis.patch.yml` 和 `cordis.include.yml` 由环境矩阵生成；团队环境配置只在 `envs.yml` 修改。
- **Session 环境隔离**：`sentry_env_switch` 只影响当前 Session 的后续调用；`use-env` 设置启动装配和新 Session 默认环境，不重绑已有 Session。
- **证据语义明确**：零值、无数据、查询失败和扫描不完整不得混用；根因需要运行时证据交叉验证。
- **依赖版本一致**：`@deepseek-ai/dsh-*` 当前统一使用 `0.2.1-rc.3` 版本线，按现有声明保持精确版本或 `^` 范围，避免 peer 上下文产生重复实例。

## 文档

- 文档入口：[docs/index.md](docs/index.md)
- 架构总览：[docs/architecture/overview.md](docs/architecture/overview.md)
- DSH 加载机制：[docs/architecture/dsh-loading.md](docs/architecture/dsh-loading.md)
- Session 环境路由：[docs/architecture/session-env-routing.md](docs/architecture/session-env-routing.md)
- 新同事接入：[docs/guides/onboarding.md](docs/guides/onboarding.md)
- 服务器部署：[docs/guides/deploy.md](docs/guides/deploy.md)
- 开发验证、发布与安装：[docs/guides/development-release-install.md](docs/guides/development-release-install.md)
