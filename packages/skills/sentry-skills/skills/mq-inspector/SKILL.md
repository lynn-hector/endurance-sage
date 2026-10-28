---
name: mq-inspector
description: 通过 RocketMQ Console 查询指定时间窗的消息记录，或按 msgId 查询消息内容与消费轨迹（sentry_query_mq）。用于验证消息存在性、内容和消费组状态；消息列表数量不等于消费积压。
---

# mq-inspector：查询 RocketMQ 消息与消费轨迹

## 使用边界

用于回答「目标消息是否存在、内容是什么、各消费组返回了什么消费轨迹」。触发场景：

- 已知 topic 和 msgId，需要检查消息详情或消费轨迹。
- 日志、链路或业务记录提供 topic 与时间窗，需要寻找关联消息。
- 需要核对消息 key、tags、properties 或消息体与上下游记录是否一致。

跳过场景：

- 缺少 topic 且无法从现有证据推导。
- 只需要 consumer lag、队列积压量或消费速率；本工具不直接提供这些指标，应查监控或消费端日志。

执行原则：

- 只读，不重投、不删除消息，不修改消费组或 topic。
- 优先窄时间窗、msgId 或关键字查询，避免无目标翻消息。
- 消息体和 properties 可能包含业务敏感信息，回答中只引用必要字段，不展示完整原文或 `raw_response`。

## 工具

### sentry_query_mq — 列表与详情双模式

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topic` | 是 | - | topic 名 |
| `msgId` | 否 | - | 提供时查单条详情与消费轨迹；省略时查消息列表 |
| `begin` / `end` | 否 | 1 小时前 / 当前时间 | 列表模式时间窗，毫秒时间戳或 ISO8601 |
| `pageNum` / `pageSize` | 否 | `1` / `10` | 列表模式分页 |
| `keyword` | 否 | `""` | 列表模式关键字过滤 |
| `dryRun` | 否 | `false` | 只构造请求，不发送 |

## 输出与证据语义

统一 evidence 信封，`type: mq`。

**列表模式**返回：

- `data.messages[]`：当前页命中的消息记录。
- `total_elements` / `total_pages`：符合 topic、时间窗和关键字条件的消息总数与页数。
- `task_id` / `truncated` / `scanned`：后台扫描任务及覆盖状态。

`total_elements` **不是未消费消息数，也不能单独证明队列积压**。RocketMQ 中保留的历史消息也可能被计入。`truncated: true` 表示扫描未完整覆盖，空结果或数量不足以支持排除结论。

**详情模式**返回：

- `message_view`：消息体、key、tags 和 properties。
- `message_track_list`：各消费组轨迹原文。
- `consumed_groups` / `not_online_groups` / `filtered_groups`：按 `trackType` 提炼的消费组。

`NOT_ONLINE` 只表示该次轨迹查询返回的状态，不单独证明消息永久丢失或消费者持续离线；`CONSUMED_BUT_FILTERED` 表示消费后被过滤，不应直接当作消费失败。需要结合消费组订阅关系、日志和后续业务结果判断。

`status=0` 时 confidence 为 0.95，否则为 0.5；查询失败为 0。confidence 描述查询结果可靠性，不代表消息消费成功率。

## 使用示例

按时间窗寻找消息：

```json
{ "topic": "topic_user", "begin": "2026-10-28T01:00:00Z", "end": "2026-10-28T02:00:00Z", "pageSize": 10 }
```

查询单条消息：

```json
{ "topic": "topic_user", "msgId": "7F0000010000D8130000000001234567" }
```

## 推荐排查路径

1. **已有 msgId**：直接查详情，核对消息内容和各消费组轨迹。
2. **只有业务标识**：用窄时间窗和 keyword 找消息，再按 msgId 查详情。
3. **怀疑消息丢失**：先确认 topic、时间窗和生产记录；列表为空还需检查扫描覆盖与过滤条件，不能直接断言未发送。
4. **怀疑消费异常**：将轨迹与对应消费组日志、重试记录和业务结果对齐。
5. **怀疑积压**：另查 consumer lag、消费速率等指标；不要用本工具的消息总数替代。

多个 topic 同时异常时，可进一步验证共同依赖，但不能仅凭时间重合认定 DB、Redis 等共同依赖就是根因。

## 检查清单

- [ ] 是否选择了与现有线索匹配的列表或详情模式。
- [ ] 是否避免了把 `total_elements` 解释为积压量。
- [ ] 空结果前是否检查时间窗、topic、keyword 和 `truncated`。
- [ ] 是否结合消费组订阅与日志解释 `trackType`。
- [ ] 是否只引用必要的消息字段，避免暴露完整消息体。
