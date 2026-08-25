# dsh-sentry

通信产品（novo-commctl）的 AIOps 故障调查员：以 DSH（deepseek-harness）原生 Cordis 插件体系构建的排障 Agent——八条证据腿（日志、链路、指标、DB、Redis、MQ、CI/CD、缺陷单）+ 方法论 persona + 危险命令门禁，在 web GUI 里以只读纪律完成「现象 → 根因 → 建议」的闭环排查。

## 能力全景

| 证据腿 | 工具 | 说明 |
|---|---|---|
| 日志 | `sentry_query_logs` / `sentry_list_log_services` | GreptimeDB k8s 容器日志，异常模式提取 |
| 链路 | `sentry_fetch_trace` | Grafana Jaeger 按 traceId 追踪，慢/错调用识别 |
| 指标 | `sentry_query_metrics` / `sentry_list_alerts` | Prometheus 曲线与 firing 告警 |
| 数据库 | `sentry_query_db` | PostgreSQL 只读 SQL（dbx 平台） |
| Redis | `sentry_query_redis` | key 值 / TTL / 类型查询 |
| MQ | `sentry_query_mq` | RocketMQ 消息列表与消费轨迹 |
| CI/CD | `sentry_query_zadig` | Zadig 服务状态、镜像版本、最近部署 |
| 缺陷单 | `sentry_query_tapd` | TAPD 缺陷单，「现象 × 已知缺陷」对账 |
| 代码 | `sentry_search_code` / `sentry_read_code` | 跨仓代码检索，作为交叉验证证据 |

另有：方法论 skill 集（10 步排查框架、各证据腿使用边界、结构化输出模板）、`git-guard` 危险 git 命令双层门禁（[docs/architecture/git-guard.md](docs/architecture/git-guard.md)）。

所有工具输出统一 `{ evidence: {...} }` 信封；错误同样以 confidence 0 的证据返回。**默认只读**，不执行任何改变线上状态的操作。

## 目录结构

```text
dsh-sentry/
├── apps/
│   ├── agent/               # 环境矩阵（envs.yml）+ patch 生成器 + 环境切换器
│   └── dev/                 # 开发探针宿主
├── packages/
│   ├── core/                # evidence 信封、datasource 基类
│   ├── services/            # 8 个数据源 service（凭据引用，不落值）
│   ├── tools/               # 9 个 model-facing 工具插件
│   ├── guard/               # git-guard 双层门禁
│   └── skills/              # persona + 方法论 skill 集
└── docs/                    # 文档地图见 docs/index.md
```

## 快速上手

```bash
pnpm install
pnpm typecheck   # 全部包类型检查
pnpm test        # vitest
```

启动与挂载（headless CLI / web GUI 两种方式）：[docs/guides/runbook.md](docs/guides/runbook.md)。
多环境切换：[docs/guides/env-switching.md](docs/guides/env-switching.md)。

## 关键约定

- **凭据只引用不落值**：环境矩阵 `apps/agent/envs.yml` 写 `*Ref` 键名，值存本机 `~/.dsh/.credentials.yaml`（见 [docs/guides/credentials.md](docs/guides/credentials.md)）
- **依赖版本**：`@deepseek-ai/dsh-*` 统一 `^0.1.0-rc.7` 范围——必须所有包同一范围，否则 pnpm 按 peer 上下文装出两份实例，nominal 品牌类型不兼容
- **运行环境**：Node ≥ 22.19，pnpm 11

## 文档

入口：[docs/index.md](docs/index.md)（使用手册 / 设计文档 / 对接档案 / 事件档案四类导航）。
