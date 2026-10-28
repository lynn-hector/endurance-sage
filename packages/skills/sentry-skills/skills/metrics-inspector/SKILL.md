---
name: metrics-inspector
description: 查询 Prometheus 指标与告警：sentry_query_metrics 查询曲线或即时点，sentry_list_metrics 发现指标名，sentry_list_alerts / sentry_get_alert_rule 查 Prometheus 告警与规则，sentry_list_am_alerts / sentry_list_am_silences 查 Alertmanager 告警和静默。
---

# metrics-inspector：查询 Prometheus 指标与告警

## 使用边界

用于确认指标是否偏离基线、异常何时开始、影响哪些维度，以及告警规则和实例之间的关系。根据当前假设选择指标，不默认查询全部指标或告警。

跳过场景：只讨论监控方案或告警策略，没有实际查询目标。缺少时间范围时优先从症状和告警推导；无法推导再追问。

执行原则：

- 只读，不修改监控或告警配置。
- 优先使用能验证当前假设的少量指标，并保留实际 PromQL、时间窗和标签条件。
- 将指标拐点与日志、链路和变更时间对齐；指标相关不单独证明因果。
- `demo` 只用于验证输出格式，不得作为真实排查证据。

## 工具

### sentry_query_metrics — 查询指标

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `start` / `end` | range 模式必填 | - | ISO8601 时间范围 |
| `time` | instant 模式必填 | - | ISO8601 即时求值时刻；提供后忽略 start/end/step |
| `metrics` | 否 | `["qps","latency_p99","error_rate"]` | 指标短名或 PromQL 数组；应根据服务类型显式选择，不盲从默认值 |
| `service` | 否 | - | 服务名，映射到集群的 `app` 标签 |
| `step` | 否 | `15s` | range 查询步长 |
| `dryRun` | 否 | `false` | 只构造请求，不发送 |
| `demo` | 否 | `false` | 返回演示数据，不连接 Prometheus |

内置短名：

| 短名 | PromQL 要点 | 单位 |
| --- | --- | --- |
| `qps` | `rate(http_server_requests_seconds_count{app="%s"}[1m])` | req/s |
| `latency_p99` / `latency_p95` | `http_server_requests_seconds_bucket` 的对应分位 | s |
| `error_rate` | `status=~"5.."` 计数占比 | ratio |
| `cpu` | `rate(process_cpu_seconds_total{app="%s"}[1m])` | cores |
| `memory` | `process_resident_memory_bytes{app="%s"}` | bytes |

集群约束：

- HTTP RED 短名适用于暴露 Spring HTTP 指标的 Java 服务。Go commctl 服务主要暴露 `go_*`、`process_*` 和业务指标，查这些短名可能无匹配序列。
- `cpu` / `memory` 使用 `process_*` 指标，但仍需确认目标服务实际暴露了对应序列。
- `error_rate` 必须提供 `service`；否则模板保留字面量 `%s`，生成无效 PromQL。
- 自定义 PromQL 直接放入 `metrics`。表达式不含大括号且提供 `service` 时，工具自动追加 `{app="..."}`；已有完整标签条件时不会追加。

### sentry_list_metrics — 发现指标名

在编写自定义 PromQL 或空结果需要核对指标名时使用。它列出最近窗口内有样本的指标名，不返回服务标签或指标值。

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `match` | 否 | - | 指标名子串过滤，忽略大小写 |
| `windowMinutes` | 否 | `60` | 回看窗口，只列窗口内有样本的指标 |
| `limit` | 否 | `40000` | 服务端返回名称上限 |
| `dryRun` / `demo` | 否 | `false` | 构造请求 / 返回演示数据 |

查不到名称只表示该窗口内没有匹配项；需要时扩大窗口并检查环境，不能据此断言指标从未配置。

### sentry_list_alerts — 查询 Prometheus firing 告警

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | 否 | - | 按 `service` 标签过滤 |
| `state` | 否 | `firing` | 兼容参数；实现固定只返回 firing |
| `demo` | 否 | `false` | 返回演示数据 |

返回的告警通常已包含 `query` 和 `duration`。已有表达式时直接下钻，无需重复查询规则。

### sentry_get_alert_rule — 查询告警规则

按名称子串、忽略大小写匹配规则，参数为 `name` 和 `demo`。返回 PromQL、`duration`、labels、annotations、当前 state 和所属 `group`，包含非 firing 规则。

同名规则可能跨 group 存在，应根据告警描述中的阈值、窗口和标签选择对应项。只有缺少表达式或需要完整规则定义时才调用。

### sentry_list_am_alerts / sentry_list_am_silences

Alertmanager 用于查看告警实例、关联告警、通知路由和静默；Prometheus 规则接口用于查看表达式。先需要全局告警面或确认静默时使用 AM，不要用它寻找规则表达式。

- `sentry_list_am_alerts`：`match` 按告警名称子串过滤，另有 `demo`。
- `sentry_list_am_silences`：`state` 可过滤 `active` / `expired`，不传返回全部，另有 `demo`。
- `active_at` / `ends_at` 是 AM 返回的时间字段；解释恢复状态时仍需指标或日志确认，不能只看单个时间字段。

## 输出与证据语义

统一 evidence 信封。指标查询 `type: metric`，`data.metrics[]` 每项包含 `name/promql/unit/mode/data_points[]`；单项失败时该项带 `error`，summary 标注失败数。

必须区分三种结果：

1. **数值为 0**：查询成功并返回值为 0 的样本，可以在该指标口径下陈述零值。
2. **`data_points: []` 且无 `error`**：查询成功，但当前条件没有返回序列。可能原因包括指标未暴露、服务或标签不匹配、时间窗无样本，不能直接解释成指标值为 0 或故障已排除。
3. **带 `error`**：查询失败，不能用于判断指标状态。

外层 confidence 主要反映查询是否成功，不代表“系统健康”或“根因已确认”。空结果需要时先用 `sentry_list_metrics` 核对指标名，再检查 `app` 标签、时间窗和服务类型。

告警查询 `type: alert`，规则查询 `type: alert-rule`，AM 查询 `type: am-alert` / `am-silence`，均保留对应 evidence 字段和错误信息。

## 推荐链路

1. 根据症状选择 RED、资源或业务指标；不确定指标名时先发现，不默认全查。
2. 用 tight time window 确认拐点和范围；告警场景可先在触发时刻做 instant 查询，再用 range 看前后趋势。
3. 空结果先核对查询条件，数值异常再下钻标签维度。
4. 将指标与日志、链路或变更证据对齐，验证因果路径。

## 检查清单

- [ ] 指标是否与服务类型和当前假设相关。
- [ ] 是否保留了实际 PromQL、时间窗和 service 条件。
- [ ] 是否区分了零值、无序列和查询失败。
- [ ] `error_rate` 是否提供 service。
- [ ] 是否仅在需要全局告警面、规则或静默信息时调用对应告警工具。
- [ ] 是否将指标拐点与其他证据对齐，而非直接认定根因。
