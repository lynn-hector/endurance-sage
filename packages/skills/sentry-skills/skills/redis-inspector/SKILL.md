---
name: redis-inspector
description: 通过 dbx 查询单个 Redis key 的值、TTL 与类型并解码返回（sentry_query_redis）。用于核对具体 key 与代码预期，不用于直接诊断 Redis 集群延迟、内存或连接数。
---

# redis-inspector：查询 Redis key 的值、TTL 与类型

## 使用边界

用于核对一个已知 Redis key 的当前值、类型和 TTL。触发场景：

- 日志、链路或代码给出具体 key，需要确认缓存状态。
- 需要验证 key 是否过期、值是否与业务记录一致、结构是否符合代码预期。

跳过场景：

- 没有具体 key，或需要扫描、搜索大量 key；本工具一次只查一个 key。
- 只讨论 Redis 架构，或只需查询集群延迟、内存、连接数和慢命令。这些需要其他指标或诊断证据。

执行原则：

- 只读，不执行写入、过期、删除等修改操作。
- 查询结果同时包含解码值和原始响应，可能含账号、会话、令牌或业务数据。只提取验证所需字段，不在回答中展示完整 `value`、`value_raw_base64` 或 `raw_response`，敏感内容必须脱敏。

## 工具

### sentry_query_redis — 查询单个 key

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `key` | 是 | - | 原始 key 字符串，工具自动进行协议所需编码 |
| `db` | 否 | 插件配置（0） | Redis db 索引 |
| `dryRun` | 否 | `false` | 只构造请求，不发送 |

dbx 登录态、Redis 连接发现和鉴权刷新由服务层处理。

## 输出与证据语义

```yaml
evidence:
  id: uuid
  source: redis-inspector
  type: redis
  timestamp: ISO8601
  data:
    env: <部署环境>
    key: "原始 key"
    key_display: string | null
    key_raw: string | null
    db: 0
    connection_id: string
    ttl: number | null
    redis_type: string | null
    value: object | string | null
    value_encoding: utf8
    value_raw_base64: string | null
    raw_response: {}
  summary: "Redis key `...` 查询完成，类型 string，TTL 710s，value 已解码"
  confidence: 0.95（有 key_display）/ 0.5
  refs: [string]
```

- 合法 JSON 会解析为对象，其他值按字符串返回；`null` 字段要保留，不自行补值。
- confidence 由返回结构中的 `key_display` 决定，不是缓存一致性或根因置信度。
- 单 key 查询只证明该 db、该 key 在查询时刻的状态，不能外推整个 Redis 或其他 key。
- TTL 和值会变化，必须与故障时间线对齐；当前值正常不能单独证明故障时刻也正常。

## 使用示例

```json
{ "key": "novo-commctl-config:ai_transcription:user_settings:call:example.com:338141295206944768" }
```

指定 db：

```json
{ "key": "some:key", "db": 1 }
```

## 推荐排查路径

1. 从日志、链路或代码确认 key 的完整拼写和 db，避免查询错误命名空间。
2. 核对 `redis_type`、`ttl` 和必要的 value 字段是否符合代码预期。
3. 需要判断缓存与数据源一致性时，与同一业务主键的 DB 记录或写入日志对齐。
4. 怀疑故障时刻的过期或污染时，结合当时日志和变更记录；不要用当前状态替代历史事实。
5. 如果出现集群级延迟、内存或连接异常，转用相应指标与日志，本工具不提供这些诊断面。

## 检查清单

- [ ] key 和 db 是否来自明确证据。
- [ ] 是否核对了类型、TTL 和必要的值字段。
- [ ] 是否区分当前状态与故障发生时刻。
- [ ] 是否与代码、DB 或日志中的预期交叉验证。
- [ ] 是否避免在回答中暴露完整缓存值和原始响应。
