---
name: zadig-inspector
description: 查询 Zadig 服务运行状态、镜像版本、最近部署与工作流历史（sentry_query_zadig），用于验证发布或运行状态假设；部署时间与故障重合只构成候选线索，不直接证明发布引入根因。
---

# zadig-inspector：查询 Zadig 部署与工作流状态

## 使用边界

用于收集发布和当前工作负载证据。触发场景：

- 需要确认服务当前镜像、版本、分支、Pod 状态或最近部署。
- 故障前后存在发布，需要验证版本和时间线是否吻合。
- 需要查询指定工作流最近任务的分支、commit、状态和部署目标。

跳过场景：只讨论 CI/CD 流程，或没有发布、版本、运行状态相关的验证目标。

执行原则：

- 只读，不触发部署、回滚或构建。
- 优先查询与当前异常有关的服务或工作流，不默认扫描全部发布历史。
- Zadig 项目名和环境名由部署配置决定，evidence 带 `project` / `env_name` 元数据。

## 工具

### sentry_query_zadig — 三种查询模式

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | 否 | - | 提供时查该服务最近部署详情；省略时列出环境服务状态 |
| `workflow` | 否 | - | 查询指定工作流最近任务；提供后优先于 `service` |
| `project` | 否 | 装配项目 | 仅工作流模式使用的项目覆盖 |
| `pageSize` | 否 | `20` | 工作流历史页大小，范围 1–50 |
| `dryRun` | 否 | `false` | 只构造请求，不发送 |
| `demo` | 否 | `false` | 返回演示数据，不作为真实证据 |

**服务列表模式**：`data.services[]` 包含 `name/status/ready/error/image/build_time/build_id/version/branch/pipeline_url`，summary 点名未就绪服务。

**服务详情模式**：`data.latest_deployment` 包含状态、副本、镜像、构建信息和 `pods[]`；Pod 可包含 `restart_count/started_at_iso/containers[].ready`，另有 `latest_started_at`。

**工作流模式**：`data.tasks[]` 包含最近任务的 id、创建人、状态、时间、构建分支或 commit 与部署目标等字段，`task_count` 是本次返回条数。

镜像 tag 可能形如 `{timestamp}-{build_id}-{version?}-{branch}`。解析后仍需确认平台时间戳的时区，不能未经验证直接附加 `Z`；应使用 evidence 中的 ISO 时间字段与故障时间线对齐。

## 输出与证据语义

统一 evidence 信封，`type: cicd`，`source: zadig-inspector`。失败时 confidence 为 0，`data.error` 带原因；演示模式不能用于真实结论。

- **部署与故障时间接近**：只能说明该发布值得优先验证，还需确认新版本实际承载异常流量，并用日志、链路或指标证明影响路径。
- **服务 Running / ready**：只说明工作负载当前就绪，不证明业务功能正常，也不排除该版本存在回归。
- **服务未就绪**：是重要异常证据，但仍需确认它与用户症状的时间和依赖关系。
- **镜像版本老旧**：本身不能推出基础设施故障或排除应用问题。
- **`restart_count`**：单次查询的累计值不能证明“正在持续增长”，需要结合 `started_at`、历史样本和重启日志。
- **不同服务版本或分支相同**：不能单独证明共享依赖或同批配置是根因。

## 使用示例

列出当前环境服务：

```json
{}
```

查询服务详情：

```json
{ "service": "commctl-config" }
```

查询工作流历史：

```json
{ "workflow": "static-code-scanning-and-build-deploy", "pageSize": 20 }
```

## 推荐排查路径

1. 从故障时间线和受影响服务出发，选择列表、服务详情或工作流模式。
2. 对齐部署或任务时间、镜像版本、分支与 commit，确认可疑版本是否在故障前生效。
3. 用部署前后日志、trace 或指标验证异常是否随版本出现，并检查影响路径。
4. 需要止损时，可以提供回滚等候选方案及影响、验证标准和 `rollback_plan`，由人类审批执行；不得仅因时间重合就宣称回滚可以根治。

## 检查清单

- [ ] 是否选择了与假设匹配的服务或工作流模式。
- [ ] 是否使用可靠时间字段对齐部署与故障，校准时区。
- [ ] 是否区分当前就绪状态与业务健康状态。
- [ ] 是否避免仅凭版本、时间重合或单次 restart_count 下因果结论。
- [ ] 是否通过日志、链路或指标验证发布影响路径。
