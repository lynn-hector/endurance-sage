# 日志查询示例与 SQL 展开

本资料提供 `log-analyzer` 的完整调用示例。示例值需替换为实际服务、ID 和时间，不要把演示时间用于真实排查。

## 1. 单服务错误日志

```json
{
  "start": "2026-07-27T10:00:00Z",
  "end": "2026-07-27T10:30:00Z",
  "services": ["commctl-config"],
  "filterOr": ["level=ERROR", "level=FATAL"]
}
```

工具展开为：

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

## 2. 多服务、关键词与精确过滤

```json
{
  "start": "2026-07-27T10:00:00Z",
  "end": "2026-07-27T10:30:00Z",
  "services": ["commctl-config", "commctl-call-control", "media-bridge"],
  "keywords": ["ERROR"],
  "filters": ["tenant=acme", "trace_id IS NOT NULL", "message NOT LIKE %healthcheck%"]
}
```

`keywords` 是 `message LIKE` 的快捷方式，多个关键词内部为 OR：

```json
{ "keywords": ["TenantAdapter", "timeout"] }
```

等价于：

```json
{ "filterOr": ["message LIKE %TenantAdapter%", "message LIKE %timeout%"] }
```

`filters` 内部为 AND；`filterOr` 先组成一个 OR 块，再与其他条件 AND。两者语义不同，不要为了组合条件把所有表达式塞进同一参数。

## 3. traceId 精查

```json
{
  "start": "2026-09-29T00:00:00Z",
  "end": "2026-09-29T12:00:00Z",
  "filters": ["trace_id=5f8a3c9e2b7d4a1f"]
}
```

不传 `services`，避免漏掉上下游服务。此调用仍使用默认 `logType=go`；为空或需要完整链路时，按实际类型分别重查，不要认为省略 logType 就会查询所有类型。

## 4. callid 桥接

先查扩展字段：

```json
{
  "start": "2026-09-29T00:00:00Z",
  "end": "2026-09-29T12:00:00Z",
  "logType": "go",
  "filters": ["not_expand LIKE %da8fa007-4639-1240-5982-a210e2cc9671%"]
}
```

从命中行提取 `trace_id`，再使用上一个示例的精查方式。若一次呼叫提取出多个 trace_id，应分别查询并按时序关联。

LIKE 不自动补 `%`，两侧必须显式书写。示例 ID 不含 `%` 或单引号；实际值仍由工具按 DSL 规则处理和转义。
