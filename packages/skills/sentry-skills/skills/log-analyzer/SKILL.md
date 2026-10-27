---
name: log-analyzer
description: 根据服务、时间范围、关键词和过滤条件从 GreptimeDB 查询 k8s 容器日志，提取异常模式（sentry_query_logs / sentry_list_log_services）。
---

# log-analyzer：查询并分析 k8s 容器日志

## 使用边界

从 GreptimeDB 查询 k8s 容器日志并提取异常模式。触发场景：

- 用户要求查询某个服务在某个时间段的日志。
- 用户要求提取错误模式、堆栈或异常趋势。
- 用户给出 `traceid=xxx` / `requestid=xxx` / `callid=xxx`，要求排查某次请求（见「按 traceId / requestId / callid 精查」）。
- 排查流程中需要收集日志证据。

跳过场景：

- 用户只是讨论日志规范、存储方案，没有要求查询具体日志。
- 缺少时间范围等必要参数且无法推导（服务名可先用 `sentry_list_log_services` 发现）。

执行原则：

- 只读操作，不修改日志数据源。
- 时间范围尽量精确到症状前后 5-15 分钟，过大会导致返回量过大、噪音多（按 traceId 精查是例外，见「按 traceId / requestId / callid 精查」）。
- 优先返回异常模式和重复错误，而不是单条日志。
- 输出必须可引用到具体的日志行或 traceId。

环境说明：数据源环境由部署配置决定（`env` 只是 evidence 里的元数据），不需要也不能在调用时指定。

## 数据源与表结构

日志存储在 GreptimeDB 的 `public.k8s_logs` 表（schema/表名有默认值）。完整字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `greptime_timestamp` | timestamp | 日志时间戳，查询的时间范围过滤字段 |
| `log_type` | string | 日志类型，如 `go`、`nginx`、`java` |
| `workload_name` | string | K8s 工作负载名，对应服务名 |
| `message` | string | 日志正文 |
| `level` | string | 日志级别，如 `INFO`、`WARN`、`ERROR`、`FATAL` |
| `trace_id` | string | 链路追踪 ID，用于关联 trace-analyzer |
| `tenant` | string | 租户标识 |
| `caller` | string | 调用者标识（代码调用位置） |
| `not_expand` | string | 扩展字段：不进 `message` 主字段的附加内容（常为 JSON），`sip_call_id`（callid，UUID 形态）、request_id 等关联标识嵌在其中；按这些 id 查询须用 `LIKE`，等值匹配无效 |

> 字段名受白名单保护，`filters` 中只能使用上表字段，非法字段会被拒绝。

## 工具

### sentry_list_log_services — 发现服务

列出近 30 分钟内有日志的所有 `workload_name`（按名称排序）。不确定服务名时先调这个。

参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `logType` | string | `go` | 日志类型 |

### sentry_query_logs — 查询日志

参数（注意：数组请传 JSON 数组，不要传逗号分隔字符串）：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `start` | 是 | - | 开始时间 ISO8601 |
| `end` | 是 | - | 结束时间 ISO8601 |
| `services` | 否 | - | 工作负载名数组，映射到 `workload_name`；单个用 `=`，多个用 `IN`；不传查询所有服务（开销大） |
| `keywords` | 否 | - | 关键词数组，对 `message` 做 `LIKE %kw%` 匹配，多个之间 OR |
| `filters` | 否 | - | 过滤 DSL 表达式数组，之间 AND 连接 |
| `filterOr` | 否 | - | 过滤 DSL 表达式数组，组成 `(...) OR (...)` 块后 AND 进 WHERE |
| `limit` | 否 | `1000` | 最大返回日志条数 |
| `logType` | 否 | `go` | 日志类型 |

### 过滤 DSL 语法

`filters` / `filterOr` 的表达式格式：

| 语法 | 生成的 SQL | 说明 |
| --- | --- | --- |
| `field=value` | `"field" = 'value'` | 等于 |
| `field!=value` | `"field" != 'value'` | 不等于 |
| `field LIKE value` | `"field" LIKE 'value'` | 模糊匹配，value 中的 `%` 保留 |
| `field NOT LIKE value` | `"field" NOT LIKE 'value'` | 排除模糊匹配 |
| `field IS NULL` | `"field" IS NULL` | 字段为空 |
| `field IS NOT NULL` | `"field" IS NOT NULL` | 字段不为空 |

规则：

- `field` 必须在字段白名单中，非法字段会被拒绝并报错。
- `value` 做单引号转义（`'` → `''`）防注入。
- `value` 外层带引号（`"..."` 或 `'...'`）时自动去掉。
- LIKE 的 value **不自动加 `%`**，需要自己写 `%keyword%`。

## SQL 拼接规则

工具内部按以下顺序拼接只读 SELECT（与实现一致）：

1. **基础条件**（始终存在，AND 连接）：`"log_type" = '...'`、`"greptime_timestamp" >= '...'`、`"greptime_timestamp" <= '...'`
2. **服务过滤**（`services`）：单个 `=`，多个 `IN (...)`，不传则不过滤。
3. **关键词**（`keywords`）：拼成 `(message LIKE ... OR ...)` 后 AND 进 WHERE。
4. **`filters`**：逐条解析后 AND 连接。
5. **`filterOr`**：组成 `(... OR ...)` 块后 AND 进 WHERE。
6. **排序与限量**：`ORDER BY "greptime_timestamp" DESC LIMIT {limit}`。

### 示例

查某服务某时间窗的错误日志：

```json
{
  "start": "2026-07-27T10:00:00Z",
  "end": "2026-07-27T10:30:00Z",
  "services": ["commctl-config"],
  "filterOr": ["level=ERROR", "level=FATAL"]
}
```

生成的 SQL：

```sql
SELECT * FROM "public"."k8s_logs"
WHERE "log_type" = 'go'
  AND "greptime_timestamp" >= '2026-07-27T10:00:00Z'
  AND "greptime_timestamp" <= '2026-07-27T10:30:00Z'
  AND "workload_name" = 'commctl-config'
  AND ("level" = 'ERROR' OR "level" = 'FATAL')
ORDER BY "greptime_timestamp" DESC
LIMIT 1000
```

多服务 + 关键词 + 精确过滤：

```json
{
  "start": "2026-07-27T10:00:00Z",
  "end": "2026-07-27T10:30:00Z",
  "services": ["commctl-config", "commctl-call-control", "media-bridge"],
  "keywords": ["ERROR"],
  "filters": ["tenant=acme", "trace_id IS NOT NULL", "message NOT LIKE %healthcheck%"]
}
```

`keywords` 是 `message LIKE` 的快捷方式：`["TenantAdapter", "timeout"]` 等价于 `filterOr: ["message LIKE %TenantAdapter%", "message LIKE %timeout%"]`。

## 按 traceId / requestId / callid 精查

用户给出 `traceid=xxx` / `requestid=xxx` 排查某次请求时，直接用 `trace_id=xxx` 作为 `filters` 精确匹配（requestId 与日志 `trace_id` 字段对齐，同 trace-analyzer 的约定），不要再叠加其他过滤条件：

- **不传 `services`**：同一 trace 贯穿多个服务，加 `workload_name` 过滤会把上下游服务的日志漏掉。
- **不主动指定 `logType`**：`log_type` 是 SQL 强制条件且默认 `go`，同一 trace 的日志可能分散在 `go`/`nginx`/`java` 多种类型下。结果为空时先换 logType 重查，不要直接断定无日志；需要完整链路时按类型各查一次。
- **放宽时间窗**：trace 的确切发生时间往往未知，不套用「5-15 分钟」原则。优先用用户给的时间线索，没有就用宽窗口（数小时至 24 小时），查不到再逐步扩大。

```json
{
  "start": "2026-09-29T00:00:00Z",
  "end": "2026-09-29T12:00:00Z",
  "filters": ["trace_id=5f8a3c9e2b7d4a1f"]
}
```

单一 trace 的日志量有限，宽窗口 + `trace_id` 精确匹配不会导致返回量失控。

### callid / requestId：从 not_expand 桥接再精查

用户给出的 id 不在 `trace_id` 字段直查命中时——典型是 `callid`，以及与日志 `trace_id` 不同值的 `request_id`——从 `not_expand` 桥接。`not_expand` 存放所有不进 `message` 主字段的扩展内容（不限于 AccessLog，常为 JSON），callid（`sip_call_id`，UUID 形态）、request_id 等关联标识嵌在其中，**等值匹配无效，必须 LIKE 模糊匹配**。分两步：

1. **桥接**：`logType=go` + `filters: ["not_expand LIKE %<id>%"]` 查出关联日志，从命中行提取 `trace_id`（一次呼叫可能对应多个 trace_id，逐个处理）：

   ```json
   {
     "start": "2026-09-29T00:00:00Z",
     "end": "2026-09-29T12:00:00Z",
     "logType": "go",
     "filters": ["not_expand LIKE %da8fa007-4639-1240-5982-a210e2cc9671%"]
   }
   ```

   DSL 的 LIKE 不会自动加 `%`，两侧要自己写；id 本身不含 `%`/单引号，无转义风险。

2. **精查**：拿 `trace_id` 按上文 traceId 规则查全量关联日志——不传 `services`、不限定 `logType`、放宽时间窗。

桥接查空时不要直接断定无日志：callid 可能是纯 SIP 层 Call-ID（`k8s_logs` 无应用日志关联），改用 `sentry_query_call_flow`（callflow-analyzer）查信令层做信令分析。

## 输出格式

输出遵循统一 evidence 信封：

```yaml
evidence:
  id: uuid
  source: log-analyzer
  type: log
  timestamp: ISO8601
  data:
    env: <部署环境>
    service: commctl-config
    start: ISO8601
    end: ISO8601
    sql: "SELECT ..."
    logs:
      - greptime_timestamp: ISO8601
        log_type: go
        workload_name: commctl-config
        message: string
        level: string
        trace_id: string
        tenant: string
        caller: string
        not_expand: string
    patterns:
      - pattern: string
        count: number
        first_at: ISO8601
        last_at: ISO8601
  summary: "env=staging service=commctl-config 时间窗 [...] 返回 N 条日志，提取 M 个模式。"
  confidence: 0-1
  refs: [...]
```

查询失败时 `confidence=0`，`data.error` 包含错误原因。

## 推荐链路

1. 不确定服务名时，先用 `sentry_list_log_services` 发现当前有日志的服务。
2. 按服务、时间范围、关键词拉取日志；结果自带轻量模式提取（`data.patterns`，指纹为前 80 个规范化字符）。
3. 将 pattern 与 trace、代码、指标关联，定位根因范围。

## 使用提示

1. 必须提供 `start`/`end`；`services` 用于过滤 `workload_name`。
2. 时间范围精确到症状前后 5-15 分钟；过大会导致返回量过大、噪音多。
3. `keywords` 对 `message` 做 LIKE 匹配，多个关键词内部 OR；需要精确过滤时用 `filters` / `filterOr`。
4. `filters` / `filterOr` 只能使用字段白名单中的字段（见上表）。
5. traceId / requestId 先试 `trace_id=xxx` 直查；不中或给的是 callid 时，用 `not_expand LIKE %xxx%`（`logType=go`，等值匹配无效）桥接出 `trace_id` 再精查（见「按 traceId / requestId / callid 精查」）。
6. 拿到异常日志后，优先提取 `trace_id` 并交给 trace-analyzer 做链路关联。
7. 日志为空时，检查时间范围、服务名拼写、`logType`（默认 `go`）是否正确。

## 检查清单

- [ ] 时间范围是否覆盖症状发生前后。
- [ ] 如不确定服务名，先用 `sentry_list_log_services` 获取。
- [ ] 关键词是否包含 ERROR、FATAL、timeout、exception 等。
- [ ] 按 traceId / requestId 精查时，是否避免了 `services`、`logType`、窄时间窗漏掉 trace 日志。
- [ ] 按 callid（或直查不中的 requestId）排查时，是否先用 `not_expand LIKE`（`logType=go`）桥接出 `trace_id` 再全量精查。
- [ ] 是否提取了重复模式而不是只展示单条日志。
- [ ] 是否关联了 traceId 或具体调用位置。
- [ ] `filters` 中的字段是否在白名单内。
