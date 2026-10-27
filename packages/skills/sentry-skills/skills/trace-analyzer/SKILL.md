---
name: trace-analyzer
description: 按 traceId 查询 Grafana Jaeger 调用链路，识别慢调用、错误调用和跨服务边界异常（sentry_fetch_trace）。
---

# trace-analyzer：分析分布式调用链路

## 使用边界

分析调用链路（trace）。触发场景：

- 用户提供了 traceId，要求分析具体链路。
- 排查流程中需要通过 traceId 与日志对齐。

跳过场景：

- 用户只是讨论链路架构，没有要求查询具体 trace。
- 缺少 `traceId` 且无法推导。

执行原则：

- 只读操作，不修改 trace 数据源。
- 优先关注 `slow_spans` 和 `errors`。
- 跨服务调用边界是重点排查区域。
- 输出必须与日志中的 `trace_id` 对齐。

## 工具

### sentry_fetch_trace — 按 traceId 查询链路

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `traceId` | 是 | - | traceId / requestId，与日志 `trace_id` 对齐 |
| `start` | 否 | `now-1h` | 开始时间，ISO8601 或 `now-1h` / `now-30m` / `now-1d` |
| `end` | 否 | `now` | 结束时间，ISO8601 或 `now` |
| `service` | 否 | - | 搜索模式：服务名（预留透传） |
| `operation` | 否 | - | 搜索模式：operation 名（预留透传） |

认证、Grafana/Jaeger 会话刷新由服务层自动处理（401 自动重登录一次），无需关心。

## 输出格式

统一 evidence 信封：

```yaml
evidence:
  id: uuid
  source: trace-analyzer
  type: trace
  timestamp: ISO8601
  data:
    env: <部署环境>
    trace_id: string
    duration_ms: number       # 全链路总耗时（最晚结束 - 最早开始）
    status: ok | error | unknown
    services: [string]        # 涉及的服务列表
    spans: []                 # 全部 span（扁平化：span_id/parent_span_id/operation_name/service_name/start_time_ms/duration_ms/tags/status）
    slow_spans: []            # 按耗时降序前 5 个且 duration > 100ms（注意包含根 span）
    errors: []                # status 为 error 的 span
    frames_count: number
    raw_response: {}          # 当无法识别响应结构时保留原始数据
  summary: "trace xxx 查询完成，总耗时 Nms，涉及服务 ...，慢调用 N 个，错误 span N 个"
  confidence: 0.9（有 spans）/ 0.5（无 spans）
  refs: [string]
```

解析器对响应结构做保守解析：结构不认识时保留 `raw_response` 原文，不会崩溃。

## 使用示例

```json
{ "traceId": "63b2cfef8ff31306944652803272c655" }
```

指定时间范围（默认 `now-1h` 到 `now`）：

```json
{
  "traceId": "63b2cfef8ff31306944652803272c655",
  "start": "2026-07-27T10:00:00Z",
  "end": "2026-07-27T10:30:00Z"
}
```

## 推荐链路

1. 通过日志中的 `trace_id` 获取具体 traceId（log-analyzer 的输出里有）。
2. 调用 `sentry_fetch_trace` 按 traceId 查询完整链路。
3. 识别慢 span（`slow_spans`）和错误 span（`errors`）。
4. 检查跨服务调用边界，判断是上游还是下游异常。
5. 与日志中的 `trace_id` 对齐，定位具体错误。

## 检查清单

- [ ] `traceId` 是否与日志中一致。
- [ ] 时间范围是否覆盖症状发生前后。
- [ ] 是否优先分析了慢调用和错误调用。
- [ ] 是否识别了跨服务调用边界。
- [ ] 注意 `slow_spans` 包含根 span 本身，不全是"慢子调用"。
