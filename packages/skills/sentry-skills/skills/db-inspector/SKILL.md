---
name: db-inspector
description: 通过 dbx 对 PostgreSQL 执行必要、可控的只读 SQL（sentry_query_db），查询业务记录、慢 SQL、锁等待、连接或主从状态，并将结果关联回代码和请求证据。
---

# db-inspector：通过 dbx 执行只读 SQL 查询

## 使用边界

用于验证明确的数据库假设，例如核对业务记录、慢 SQL、锁等待、连接状态或主从延迟。触发场景：

- 日志、链路或指标出现 SQL 超时、锁等待或连接异常。
- 需要核对同一业务主键在数据库中的实际状态。
- 已有具体 SQL 或代码路径，需要验证执行结果或相关状态。

跳过场景：只讨论数据库设计，或没有具体假设而无目标查询业务表。

执行原则：

- 只执行只读 SQL，不执行 DML、DDL、数据修复或其他状态变更。
- 优先使用业务主键、明确时间窗和 `LIMIT` 缩小范围，避免全表扫描、长事务和高成本查询。
- `maxRows` 限制返回行数，不保证数据库执行成本受限；查询本身仍需控制扫描范围。
- `EXPLAIN ANALYZE` 会实际执行语句，不能当作普通 `EXPLAIN`；有负载风险时不得使用。
- 只选择必要字段，避免在回答中暴露凭据、个人数据或完整业务记录。

## 工具

### sentry_query_db — 执行只读 SQL

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sql` | 是 | - | 只读 SQL 语句 |
| `database` | 否 | 插件配置 | 数据库名，通常无需覆盖 |
| `maxRows` | 否 | `100` | 最大返回行数 |
| `dryRun` | 否 | `false` | 只构造请求，不发送；不代表已验证 SQL 成本或安全性 |

dbx 登录、PostgreSQL 连接发现和鉴权刷新由服务层处理。

## 输出与证据语义

统一 evidence 信封：

```yaml
evidence:
  id: uuid
  source: db-inspector
  type: db
  timestamp: ISO8601
  data:
    env: <部署环境>
    sql: string
    database: string
    connection_id: string
    columns: [string]
    column_types: [string]
    rows: [any[]]
    row_count: number
    execution_time_ms: number | null
    truncated: boolean
    affected_rows: number
    raw_response: [...]
  summary: "SQL 查询完成，返回 N 行，执行 M ms[, 结果已被截断]"
  confidence: 0.95（有结果集）/ 0.5
  refs: [string]
```

- 只将第一个结果集展开到 `columns/rows` 等字段，完整结果集保留在 `raw_response`。
- `row_count` 是当前返回行数；`truncated: true` 时不能据此判断全部匹配数量。
- 空 `rows` 只表示当前 SQL 和条件下没有返回记录，应核对 database、时间窗、过滤条件和事务可见性，不直接证明数据从未存在。
- confidence 反映是否取得结果集，不表示查询有行，也不代表根因置信度。

## 使用示例

核对单个业务记录：

```json
{
  "sql": "SELECT * FROM \"public\".\"tb_business_hours_day\" WHERE \"id\" = 'example-id' LIMIT 1",
  "maxRows": 1
}
```

## 推荐排查路径

1. 从异常日志、慢 SQL 或代码中确定要验证的具体对象和条件。
2. 用最小查询确认相关记录或数据库状态，并保留 SQL、时间窗和返回行数。
3. 慢 SQL 结合执行计划和代码调用点判断；锁等待同时核对阻塞会话，连接异常结合连接池指标判断。
4. 将数据库结果与请求 trace、应用日志或上下游业务记录交叉验证。
5. 需要优化索引、修改 SQL、切换流量或修复数据时，只提供带验证和回滚的方案，由人类执行。

## 检查清单

- [ ] SQL 是否只读且服务于明确假设。
- [ ] 是否限制了查询范围、返回字段和行数。
- [ ] 是否检查了 `truncated`，并正确解释空结果。
- [ ] 是否避免高成本查询和未评估的 `EXPLAIN ANALYZE`。
- [ ] 是否将结果与代码、日志或链路关联，并保护敏感数据。
