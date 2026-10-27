---
name: zadig-inspector
description: 查询 Zadig 环境各服务运行状态、镜像版本与最近一次部署详情，判断故障是否由发布引入（sentry_query_zadig）。
---

# zadig-inspector：查询 Zadig 部署状态

## 使用边界

查询 Zadig 环境中各服务的当前运行状态、镜像版本与最近一次部署详情，帮助判断故障是否由最近发布引入。触发场景：

- 用户怀疑最近部署导致服务异常，需要查看构建/部署状态。
- 排查流程中需要收集 CI/CD 侧证据。
- 多个服务同时异常，需要确认是否来自同一批次部署。

跳过场景：

- 用户只是讨论 CI/CD 流程或发布策略，没有要求查询具体状态。

执行原则：

- 只读操作，不触发任何部署、回滚或构建动作。
- 优先关注最近一次部署的时间、镜像版本、分支、运行状态。
- 多个服务同时异常时，优先查看它们最近一次部署的时间是否重叠。
- 状态非 `Running` 或 `ready` 非 `ready` 的服务是首要排查对象。

环境说明：Zadig 项目名/环境名由部署配置决定，evidence 里带 `project`/`env_name` 元数据。

## 工具

### sentry_query_zadig — 查询部署状态（双模式）

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | 否 | - | 提供时查该服务最近一次部署详情；省略时列出环境内所有服务状态 |
| `demo` | 否 | `false` | 返回演示数据，不调用真实 API |

**列表模式**（省略 `service`）：`data.services[]`，每项含 `name/status/ready/error/image/build_time/build_id/version/branch/pipeline_url`，按名称排序；summary 会点名未就绪的服务。

**详情模式**（提供 `service`）：`data.latest_deployment`，含 `status/ready/replicas/image/…/pods[]`（pod 的 `restart_count/started_at_iso/containers[].ready`）与 `latest_started_at`。

镜像 tag 解析规则：`{timestamp}-{build_id}-{version?}-{branch}`，如 `20260727155647-3325-263.0.2.1-dev` → 构建时间 2026-07-27T15:56:47Z、build 3325、版本 263.0.2.1、分支 dev。

## 输出格式

统一 evidence 信封，`type: cicd`，`source: zadig-inspector`。失败时 `confidence: 0`，`data.error` 带原因。

## 使用示例

```json
{}
```

```json
{ "service": "commctl-config" }
```

## 排查方法论

### 排查步骤

1. **收集时间线**：获取故障首次发生时间（告警、日志、trace、用户反馈）。
2. **列表模式整体扫描**：关注 `status` 非 `Running` / `ready` 非 `ready` 的服务；多个服务的 `build_time` 或 `branch` 是否相同或接近；与故障时间线重合的部署。
3. **详情模式定位可疑服务**：关注 `latest_deployment.status/ready`、`build_time/version/branch` 是否为可疑构建、`pods` 中的 `restart_count/started_at/containers_ready`；`pipeline_url` 可跳转 Zadig Web UI。
4. **交叉验证**：log-analyzer 看部署前后日志变化；trace-analyzer 看部署后新错误码/延迟；metrics-inspector 看指标拐点。

### 假设表

| 证据 | 假设 |
| --- | --- |
| 部署时间与故障时间高度重合 | 本次部署引入回归 |
| 多个服务同时异常且版本/分支相同 | 共享依赖或配置变更导致 |
| 镜像版本老旧但服务运行正常 | 问题可能来自基础设施 |
| 部署成功但 pod restart_count 增长 | 代码逻辑或启动依赖问题 |

### 边界

- 只查询，不触发部署、回滚、构建。
- 不要给出回滚建议，除非已有人工确认。

## 检查清单

- [ ] 是否只执行了只读查询。
- [ ] 部署时间与故障时间是否对齐。
- [ ] 多个异常服务的部署时间是否重叠。
- [ ] 是否结合日志和链路进行了交叉验证。
