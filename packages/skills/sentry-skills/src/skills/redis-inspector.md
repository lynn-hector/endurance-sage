# redis-inspector：查询 Redis key 的值、TTL 与类型

## 使用边界

通过 dbx 平台查询 Redis 指定 key 的值、TTL 和类型，返回 base64 解码后的值。触发场景：

- 用户怀疑某个 Redis key 的值、过期时间或类型与故障相关。
- 排查流程中需要收集 Redis 证据。
- 日志/链路/代码中出现具体 Redis key，需要确认其当前状态。

跳过场景：

- 用户只是讨论 Redis 架构或缓存策略，没有要求查询具体 key。
- 缺少 key 且无法推导。

执行原则：

- 只读操作，不执行任何修改 Redis 数据的命令。
- 查询结果包含原始值（base64）和解码后的值，方便上层推理。

dbx 登录态检查、redis 连接发现、鉴权失败重试由服务层自动处理。

## 工具

### sentry_query_redis — 查询 key

参数：

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `key` | 是 | - | 要查询的 Redis key（原始字符串，自动 base64 编码） |
| `db` | 否 | 插件配置（0） | Redis db 索引 |
| `dryRun` | 否 | `false` | 只返回构造好的请求体，不发送 |

## 输出格式

统一 evidence 信封：

```yaml
evidence:
  id: uuid
  source: redis-inspector
  type: redis
  timestamp: ISO8601
  data:
    env: <部署环境>
    key: "原始 key"
    key_display: string
    key_raw: string          # base64
    db: 0
    connection_id: string
    ttl: number | null       # 秒
    redis_type: string | null
    value: object | string   # 解码后：合法 JSON 保持对象结构，否则为字符串
    value_encoding: utf8
    value_raw_base64: string
    raw_response: {}         # dbx 原始响应
  summary: "Redis key `...` 查询完成，类型 string，TTL 710s，value 已解码"
  confidence: 0.95（有 key_display）/ 0.5
  refs: [string]
```

## 使用示例

```json
{
  "key": "novo-commctl-config:ai_transcription:user_settings:call:chenwt.com:338141295206944768"
}
```

指定 db：

```json
{ "key": "some:key", "db": 1 }
```

## 排查方法论

### 常见症状

- 应用出现 Redis 超时、响应慢
- 连接数报警
- 内存突增

### 排查步骤

1. **拿到可疑 key**：从日志或链路中提取；本工具一次只查一个 key。
2. **对比预期**：将 `value`、`ttl` 与代码预期对比，判断缓存不一致、过期或污染。
3. **交叉验证**：结合 log-analyzer / trace-analyzer 的时间窗对比。

### 典型根因

| 现象 | 可能根因 |
| --- | --- |
| 大量超时 | 慢命令阻塞、blocked_clients 高 |
| 内存突增 | 大 key、缓存未设置过期、热 key 集中 |
| 连接数报警 | 连接泄漏、短连接过多、未使用连接池 |
| 响应慢 | 大 key、网络延迟、CPU 满载 |

### 止损建议

- 热 key：考虑本地缓存或拆分 key。
- 大 key：拆分 value 或调整数据结构。
- 连接泄漏：重启应用并修复连接池配置（重启有风险，需先评估）。

## 检查清单

- [ ] 是否只执行了只读查询。
- [ ] 是否检查了 `ttl` 和 `redis_type`。
- [ ] 是否将 value 与代码预期或日志上下文进行对比。
- [ ] 是否保留了 `raw_response` 以便复现。
