---
name: log-analyzer
description: 从 GreptimeDB 查询 k8s 容器日志并提取异常模式（sentry_query_logs / sentry_list_log_services）；支持服务、时间窗、关键词和过滤 DSL，以及按 traceId、requestId、callid 关联查询。
---

# log-analyzer：查询并分析 k8s 容器日志

## 使用边界

用于查询具体日志、提取重复异常模式，以及通过 traceId / requestId / callid 追踪请求。只讨论日志规范而没有查询目标时不加载。

执行原则：

- 只读，优先使用能验证当前假设的服务、时间窗和过滤条件。
- 普通服务排查优先覆盖症状前后 5–15 分钟；按 ID 精查可按线索放宽到数小时或 24 小时。
- 优先分析 `patterns` 和代表性日志，不逐条罗列全部结果。
- 输出保留具体日志行、traceId、实际 SQL 和时间窗；空结果不直接等于无异常。
- 数据源环境由 Session 绑定决定，`env` 是 evidence 元数据，不是查询参数。

## 数据源与字段

日志位于 GreptimeDB `public.k8s_logs`：

| 字段 | 说明 |
| --- | --- |
| `greptime_timestamp` | 日志时间戳与时间过滤字段 |
| `log_type` | 日志类型，如 `go`、`nginx`、`java` |
| `workload_name` | K8s 工作负载名，对应服务名 |
| `message` | 日志正文 |
| `level` | `INFO` / `WARN` / `ERROR` / `FATAL` 等 |
| `trace_id` | 关联链路的 trace ID |
| `tenant` | 租户标识 |
| `caller` | 代码调用位置 |
| `not_expand` | 未进入 `message` 的扩展内容，常为 JSON；可能含 `sip_call_id`、`request_id` |

`filters` / `filterOr` 只能使用以上字段，非法字段会被拒绝。

## 工具

### sentry_list_log_services — 发现服务

列出近 30 分钟内有日志的 `workload_name`，参数 `logType` 默认 `go`。不确定服务名时使用；查不到只表示该类型和窗口内没有日志。

### sentry_query_logs — 查询日志

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `start` / `end` | 是 | - | ISO8601 时间范围 |
| `services` | 否 | 全部 | `workload_name` 数组；不传会查询所有服务，成本较高 |
| `keywords` | 否 | - | 对 `message` 做 `LIKE %kw%`，多个关键词之间 OR |
| `filters` | 否 | - | DSL 数组，条件之间 AND |
| `filterOr` | 否 | - | DSL 数组，组成 OR 块后再与其他条件 AND |
| `limit` | 否 | `1000` | 最大返回条数 |
| `logType` | 否 | `go` | 日志类型；省略不等于查询全部类型 |

数组参数必须传 JSON 数组，不能传逗号分隔字符串。

### 过滤 DSL

| 语法 | 生成的 SQL |
| --- | --- |
| `field=value` | `"field" = 'value'` |
| `field!=value` | `"field" != 'value'` |
| `field LIKE value` | `"field" LIKE 'value'` |
| `field NOT LIKE value` | `"field" NOT LIKE 'value'` |
| `field IS NULL` | `"field" IS NULL` |
| `field IS NOT NULL` | `"field" IS NOT NULL` |

值中的单引号会转义；外层引号自动去除。`LIKE` 不自动添加 `%`，需要写成 `message LIKE %timeout%`。

## SQL 拼接顺序

1. 基础条件：`"log_type" = '...'`、`"greptime_timestamp" >= '...'`、`"greptime_timestamp" <= '...'`。
2. `services` 映射到 `"workload_name"`，单服务 `=`，多服务 `IN`。
3. `keywords` 组成 `message LIKE ... OR ...`。
4. `filters` 逐条 AND。
5. `filterOr` 组成一个 OR 块后 AND。
6. 按 `"greptime_timestamp" DESC` 排序并应用 `LIMIT`。

完整 JSON 与 SQL 展开示例见 [查询示例](references/query-examples.md)。

## 按 traceId / requestId 精查

当日志的 `trace_id` 与目标 ID 对齐时，使用 `filters: ["trace_id=xxx"]`：

- 不传 `services`，避免漏掉同一 trace 的上下游服务。
- 不叠加无关关键词或过滤条件。
- 根据已知时间线索设置窗口；没有线索时可先宽查，再按结果收敛。
- `logType` 默认 `go`，省略参数不会跨类型查询。结果为空或需要完整链路时，按 `go` / `nginx` / `java` 等实际类型分别查询。

单一 trace 的日志通常有限，宽窗口加精确 ID 不等同于全量日志扫描。

## callid / requestId：通过 not_expand 桥接

目标 ID 不在 `trace_id` 中，典型如 SIP `callid` 或独立的 `request_id` 时：

1. 用 `logType=go` 和 `filters: ["not_expand LIKE %<id>%"]` 找关联日志。`not_expand` 中的 ID 必须 LIKE，等值匹配无效。
2. 从命中行提取 `trace_id`；一次呼叫可能对应多个 trace，分别处理。
3. 再按上文 traceId 规则查询完整应用日志，不限制服务，并按需分 logType 查询。

桥接为空时先检查时间窗和 ID 类型。纯 SIP Call-ID 可能没有应用日志，应改用 `callflow-analyzer` 查询信令，不能直接断定通话不存在。

## 输出与结果解释

统一 evidence 信封，`type: log`：

- `data.logs[]` 保留时间、服务、级别、message、trace_id、caller 和 not_expand 等字段。
- `data.patterns[]` 是轻量重复模式，包含 count、first_at、last_at；指纹取规范化文本前 80 字符。
- `data.sql/start/end/env` 是复核查询范围的必要锚点。
- 查询失败 confidence 为 0，`data.error` 带原因。

空结果只表示当前环境、logType、时间窗和过滤条件下未命中。排除假设前检查服务名、时区、ID 所在字段和日志类型。日志正文及扩展字段可能含敏感信息，只引用必要片段并脱敏。

## 推荐链路

1. 服务名不确定时先发现服务；已有明确 ID 时直接精查，不做无目标全服务搜索。
2. 按服务或 ID 查询，先看重复异常模式和代表性错误。
3. 提取 trace_id 交给 `trace-analyzer`，或用 caller、错误文本交给 `code-repository`。
4. 用指标、链路或代码验证日志所提示的因果路径。

## 检查清单

- [ ] 时间窗、环境、服务名和 logType 是否明确。
- [ ] 数组与 DSL 是否符合工具契约，LIKE 是否显式包含 `%`。
- [ ] 按 traceId 精查时是否避免 services 和无关过滤条件。
- [ ] callid 或独立 requestId 是否先通过 not_expand 桥接。
- [ ] 空结果是否检查了 logType、时间窗和过滤条件，而非直接排除。
- [ ] 是否提炼重复模式并关联 trace 或代码位置。
