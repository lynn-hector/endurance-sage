# db-inspector：通过 dbx 执行只读 SQL 查询

## 使用边界

通过 dbx 平台对 PostgreSQL 数据库执行只读 SQL 查询，获取数据库状态、慢 SQL、连接数、主从延迟等证据。触发场景：

- 用户怀疑数据库是瓶颈或异常来源。
- 排查流程中需要收集数据库证据。
- 日志/链路中出现 SQL 超时或连接异常。

跳过场景：

- 用户只是讨论数据库架构或表设计，没有要求查询具体状态。

执行原则：

- 只读操作，不执行任何修改数据库的命令。
- 线上环境只查询状态表和慢日志，避免长事务。
- 慢 SQL 需要回到代码定位调用点。
- 连接数接近上限时，评估是否存在连接泄漏。

dbx 登录、postgres 连接发现、鉴权失败重试由服务层自动处理，无需关心。

## 工具

### sentry_query_db — 执行只读 SQL

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sql` | 是 | - | 要执行的只读 SQL 语句 |
| `database` | 否 | 插件配置 | 数据库名（配置里已设默认库，一般不用传） |
| `maxRows` | 否 | `100` | 单次查询最大返回行数 |
| `dryRun` | 否 | `false` | 只返回构造好的请求体，不发送 |

## 输出格式

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
    rows: [any[]]          # 只取第一个结果集
    row_count: number
    execution_time_ms: number
    truncated: boolean
    affected_rows: number
    raw_response: [...]
  summary: "SQL 查询完成，返回 N 行，执行 M ms[, 结果已被截断]"
  confidence: 0.95（有结果）/ 0.5（空结果）
  refs: [string]
```

## 使用示例

```json
{
  "sql": "SELECT * FROM \"public\".\"tb_business_hours_day\" LIMIT 1"
}
```

## 排查方法论

### 常见症状

- SQL 超时、响应慢
- 连接数报警
- 主从延迟高

### 排查步骤

1. **检查慢 SQL**：按时间范围查询慢 SQL，关注执行次数和平均耗时；高 count + 高耗时的 SQL 优先处理。
2. **检查连接状态**：总连接数、活跃连接、等待连接；等待连接数持续高，说明连接池不足或存在长事务。
3. **检查主从延迟**：读写分离场景下主从延迟高会导致读到旧数据。
4. **关联代码**：通过 SQL 内容定位 DAO/Repository 代码（等 code-repository 工具就绪），检查是否缺少索引、全表扫描、嵌套循环查询。

### 典型根因

| 现象 | 可能根因 |
| --- | --- |
| SQL 超时 | 缺少索引、大表扫描、锁等待 |
| 连接数报警 | 连接池泄漏、慢 SQL 占用连接、突发流量 |
| 主从延迟高 | 大事务、从库性能差、网络延迟 |
| 响应慢 | 慢 SQL、锁竞争、Buffer Pool 不足 |

### 止损建议

- 添加或优化索引（在线 DDL 需谨慎）。
- 优化慢 SQL，减少扫描范围。
- 连接数过高时考虑限流或扩容（评估后执行）。
- 主从延迟高时临时切换读流量到主库（需评估主库负载）。

## 检查清单

- [ ] 是否只执行了只读查询。
- [ ] 慢 SQL 是否已关联到代码调用点。
- [ ] 是否评估了连接泄漏风险。
