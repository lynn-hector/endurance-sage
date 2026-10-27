---
name: metrics-inspector
description: 查询 Prometheus 指标曲线与 firing 告警，识别异常拐点（sentry_query_metrics / sentry_list_alerts）。另含 sentry_get_alert_rule（按名称查规则表达式与 for 时长，告警分析第一步）；sentry_list_am_alerts / sentry_list_am_silences 查 Alertmanager 活跃告警与静默。
---

# metrics-inspector：查询 Prometheus 指标与告警

## 使用边界

查询 Prometheus 指标和告警，识别异常曲线。触发场景：

- 用户要求查看某个服务或全局的指标曲线。
- 排查流程中需要收集指标证据。
- 用户提供了告警名，要求查看告警详情。

跳过场景：

- 用户只是讨论监控方案或告警策略，没有要求查询具体指标。
- 缺少时间范围且无法推导。

执行原则：

- 只读操作，不修改任何监控配置。
- 至少同时查询 qps、latency_p99、error_rate。
- 关注拐点时间，与日志和告警时间对齐。
- 指标异常但日志无异常时，考虑基础设施或网络问题。

## 工具

### sentry_query_metrics — 查询指标

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `start` | 条件（range 模式必填） | - | 开始时间 ISO8601 |
| `end` | 条件（range 模式必填） | - | 结束时间 ISO8601 |
| `time` | 条件（instant 模式必填） | - | ISO8601 即时求值时刻；提供时走 instant 单点查询（告警触发时刻打点），忽略 start/end/step |
| `metrics` | 否 | `["qps","latency_p99","error_rate"]` | 指标短名或 PromQL 表达式数组 |
| `service` | 否 | - | 服务名，用于 `{service="..."}` 标签过滤 |
| `step` | 否 | `15s` | Prometheus 查询步长 |
| `demo` | 否 | `false` | 返回演示数据，不连接 Prometheus |

查询经 Grafana 数据源代理（datasource uid `prometheus`），认证与链路查询共用 Grafana 凭据。

内置指标短名（模板已按集群实际指标校准——标签是 `app`，HTTP 指标为 Spring 命名）：

| 短名 | PromQL 要点 | 单位 |
| --- | --- | --- |
| `qps` | `rate(http_server_requests_seconds_count{app="%s"}[1m])` | req/s |
| `latency_p99` | `http_server_requests_seconds_bucket` 的 0.99 分位 | s |
| `latency_p95` | 同上 0.95 | s |
| `error_rate` | `status=~"5.."` 计数占比 | ratio |
| `cpu` | `rate(process_cpu_seconds_total{app="%s"}[1m])` | cores |
| `memory` | `process_resident_memory_bytes{app="%s"}` | bytes |

集群现实（重要）：
- **HTTP RED 指标只存在于 Java 服务**（ai-voice/push/platform/infrastructure）。Go 的 commctl 服务只暴露 `go_*`/`process_*`/业务指标（如 `novo_novo_commctl_config_*`）——对它们查 qps/latency/error_rate 返回空序列是**真实零值**，不是错误；cpu/memory 全服务可用。
- `error_rate` 必须提供 `service`——不带时模板中 `{app="%s",status=~"5.."}` 不会被替换，生成带字面量 `%s` 的非法 PromQL（原实现怪癖，保留）。
- 告警查询（`sentry_list_alerts`）在 grafana 代理模式下经数据源 resources 透传 `/api/datasources/uid/<uid>/resources/api/v1/rules`，与指标查询共用同一条代理链路。

自定义 PromQL：直接把表达式放进 `metrics` 数组；表达式不含大括号且提供 `service` 时会自动追加 `{app="..."}` 过滤。查 Go 服务业务指标时直接写全名，如 `rate(novo_novo_commctl_config_fs_event_dead_letter_total[5m])`。

### sentry_list_alerts — 查询告警

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | 否 | - | 按 `service` 标签过滤 |
| `state` | 否 | `firing` | 兼容参数：实现固定只返回 firing 告警，传其他值无效（原实现如此） |
| `demo` | 否 | `false` | 返回演示数据 |

### sentry_get_alert_rule — 查询告警规则

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | 是 | - | 规则名称子串，忽略大小写 |
| `demo` | 否 | `false` | 返回演示数据 |

按规则名称子串（忽略大小写）查询告警规则定义：返回 PromQL 表达式（`query`）、for 时长（`duration`，秒）、labels、annotations 与当前 state（firing/inactive/pending 都返回——分析历史告警时规则可能已恢复）。同名规则可跨规则组存在（如 L1/L2 两组同名），每条结果带 `group` 字段，按告警描述中的阈值/窗口文本比对选中。

告警分析的第一步：从告警名称拿到表达式，再去 `sentry_query_metrics` 下钻表达式里的指标与分组维度。

### sentry_list_am_alerts / sentry_list_am_silences

Alertmanager 视角（经 Grafana 代理）：`sentry_list_am_alerts` 列活跃告警实例——名称、labels、`active_at`/`ends_at`（预测恢复）、`fingerprint`、`receivers`；`sentry_list_am_silences` 列静默规则（active/expired 可过滤）。

定位分工：规则**表达式**只在 Prometheus（`sentry_get_alert_rule`）；Alertmanager 只有触发后的实例与路由信息。分析告警时先看 AM 总览（关联告警、风暴识别、是否被静默），再下钻规则。

参数：

`sentry_list_am_alerts`：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `match` | 否 | - | 告警名称子串过滤，忽略大小写 |
| `demo` | 否 | `false` | 返回演示数据 |

`sentry_list_am_silences`：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `state` | 否 | - | 静默状态过滤：`active` 或 `expired`，不传返回全部 |
| `demo` | 否 | `false` | 返回演示数据 |

## 输出格式

统一 evidence 信封。指标查询 `type: metric`，`data` 带 `mode: instant | range`，`data.metrics[]` 含每个指标的 `name/promql/unit/mode/data_points[]`（timestamp/value/labels）；部分指标失败时 summary 标注 `N 个失败`，confidence 降为 0.5。告警查询 `type: alert`，`data.alerts[]` 含 `name/state/severity/query/duration/started_at/labels/annotations/value`——`query` 是规则的 PromQL 表达式、`duration` 是 for 时长（秒，缺失为 null），**已随告警返回，通常无需再调 `sentry_get_alert_rule` 取表达式**。规则查询 `type: alert-rule`，`data` 含 `env/name_filter/rules[]/match_count`，`rules[]` 每条含 `name/group/query/duration/labels/annotations/state/firing[]`。AM 查询 `type: am-alert` / `am-silence`，`data.alerts[]`、`data.silences[]` 字段同上两节。

## 使用示例

```json
{
  "start": "2026-07-22T10:00:00Z",
  "end": "2026-07-22T10:30:00Z",
  "service": "order-service"
}
```

自定义 PromQL：

```json
{
  "start": "2026-07-22T10:00:00Z",
  "end": "2026-07-22T10:30:00Z",
  "service": "order-service",
  "metrics": ["rate(http_requests_total[1m])"]
}
```

查告警：

```json
{ "service": "order-service" }
```

## 推荐链路

1. 查询关键指标曲线（qps / latency_p99 / error_rate）。
2. 获取活跃告警列表（`sentry_list_alerts`）。
3. 将指标拐点与日志、链路、告警时间对齐。

## 检查清单

- [ ] 是否查询了 qps、latency、error_rate。
- [ ] error_rate 是否带了 service。
- [ ] 是否获取了活跃告警。
- [ ] 是否识别了指标拐点时间。
- [ ] 是否与日志/告警时间对齐。
- [ ] `demo` 仅用于验证输出格式，不用于真实排查。
