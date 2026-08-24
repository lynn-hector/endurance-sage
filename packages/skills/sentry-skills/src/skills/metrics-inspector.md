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
| `start` | 是 | - | 开始时间 ISO8601 |
| `end` | 是 | - | 结束时间 ISO8601 |
| `metrics` | 否 | `["qps","latency_p99","error_rate"]` | 指标短名或 PromQL 表达式数组 |
| `service` | 否 | - | 服务名，用于 `{service="..."}` 标签过滤 |
| `step` | 否 | `15s` | Prometheus 查询步长 |
| `demo` | 否 | `false` | 返回演示数据，不连接 Prometheus |

内置指标短名：

| 短名 | 含义 | 单位 |
| --- | --- | --- |
| `qps` | 每秒请求数 | req/s |
| `latency_p99` | P99 延迟 | s |
| `latency_p95` | P95 延迟 | s |
| `error_rate` | 5xx 错误率 | ratio |
| `cpu` | CPU 使用率 | ratio |
| `memory` | 常驻内存 | bytes |

**注意**：`error_rate` 必须提供 `service`——不带 service 时模板中的 `{service="%s"}` 不会被替换，会生成带字面量 `%s` 的非法 PromQL（原实现如此，已知的兼容性怪癖）。

自定义 PromQL：直接把表达式放进 `metrics` 数组；表达式不含大括号且提供 `service` 时会自动追加 `{service="..."}` 过滤。

### sentry_list_alerts — 查询告警

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service` | 否 | - | 按 `service` 标签过滤 |
| `state` | 否 | `firing` | 兼容参数：实现固定只返回 firing 告警，传其他值无效（原实现如此） |
| `demo` | 否 | `false` | 返回演示数据 |

## 输出格式

统一 evidence 信封。指标查询 `type: metric`，`data.metrics[]` 含每个指标的 `name/promql/unit/data_points[]`（timestamp/value/labels）；部分指标失败时 summary 标注 `N 个失败`，confidence 降为 0.5。告警查询 `type: alert`，`data.alerts[]` 含 `name/state/severity/started_at/labels/annotations/value`。

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
