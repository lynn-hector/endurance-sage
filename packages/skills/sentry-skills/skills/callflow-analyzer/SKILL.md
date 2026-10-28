---
name: callflow-analyzer
description: 按 callid 查询 GreptimeDB hep_1 表的 SIP 信令流，还原 INVITE/180/200/BYE 时序与 PDD，识别错误响应（≥400，401 认证质询不计入）；trace_id 桥接回日志与链路（sentry_query_call_flow）。
---

# callflow-analyzer：查询并分析 SIP 信令流

## 使用边界

从 GreptimeDB 的 `hep_1` 表查询 SIP 信令（HEP 采集的通话信令）并还原时序。触发场景：

- 用户给出 `callid=xxx`，要求排查某次通话/呼叫的信令问题。
- 排查流程中需要信令层证据：呼叫未到达、被拒、未接通、异常挂断。
- 从日志（`not_expand` 桥接出的 callid）需要信令侧对齐时。

跳过场景：

- 用户只是讨论信令协议/规范，没有要求查询具体通话。
- 用户给的是 traceid/requestid（走 log-analyzer / trace-analyzer 直查）。

执行原则：

- 只读操作，不修改信令数据源。
- 查询键是 `call_id = ? OR trace_id = ?` 双匹配（与 hep_1 dashboard 行为一致）。
- 优先还原事件时序（INVITE → 180 → 200 → BYE）和识别失败响应，而不是逐条罗列 payload。

环境说明：数据源环境由部署配置决定（`env` 只是 evidence 里的元数据），不需要也不能在调用时指定。

## 数据源与表结构

信令存储在 GreptimeDB 的 `public.hep_1` 表（schema/表名有默认值）。完整字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `greptime_timestamp` | timestamp | 消息时间戳，查询的时间范围过滤字段 |
| `src_ip` / `src_port` | string / int | 源地址 |
| `dst_ip` / `dst_port` | string / int | 目标地址 |
| `sip_method` | string | SIP 方法（INVITE/BYE/CANCEL/REGISTER…）或响应码（100/180/200/403/487…） |
| `call_id` | string | Call-ID，关联同一通话的所有信令 |
| `trace_id` | string | 链路追踪 ID，桥接回日志与 Jaeger |
| `node_name` | string | 采集节点 |
| `payload` | string | SIP 消息完整内容 |
| `payload_size` | int | Payload 大小（字节） |

## 工具

### sentry_query_call_flow — 按 callid 查询信令流

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `callId` | 是 | - | callid；同时匹配 `call_id` 与 `trace_id`（OR） |
| `start` | 否 | now-24h | 开始时间 ISO8601 |
| `end` | 否 | now | 结束时间 ISO8601 |
| `limit` | 否 | `1000` | 最大返回消息条数 |

生成的 SQL（时间**升序**，与日志查询的降序不同）：

```sql
SELECT * FROM "public"."hep_1"
WHERE ("call_id" = 'xxx' OR "trace_id" = 'xxx')
  AND "greptime_timestamp" >= '...'
  AND "greptime_timestamp" <= '...'
ORDER BY "greptime_timestamp" ASC
LIMIT 1000
```

## 输出格式

统一 evidence 信封（`data.messages` 按时间升序）：

```yaml
evidence:
  id: uuid
  source: callflow-analyzer
  type: callflow
  timestamp: ISO8601
  data:
    env: <部署环境>
    call_id: string
    start: ISO8601
    end: ISO8601
    sql: "SELECT ..."
    messages:
      - greptime_timestamp: ISO8601
        sip_method: INVITE
        src_ip: string
        src_port: int
        dst_ip: string
        dst_port: int
        call_id: string
        trace_id: string
        node_name: string
        payload: string
        payload_size: int
    summary:
      total: number
      first_at: ISO8601
      last_at: ISO8601
      method_counts: { INVITE: 1, "180": 1 }
      milestones:           # 通话关键里程碑（首个出现时间），未发生则无该字段
        invite_at: ISO8601
        ringing_at: ISO8601  # 180 Ringing 或 183 Session Progress，先到先记
        answer_at: ISO8601  # INVITE 之后且 CANCEL 之前的 200 才算接通（CANCEL 自己的 200 OK 不是应答）
        bye_at: ISO8601
        cancel_at: ISO8601
      pdd_ms: number        # answer_at - invite_at；缺任一则无此字段
      error_responses: { "403": 1, "487": 1 }  # ≥400 响应码计数（401 认证质询不计入）
      call_ids: [string]    # 去重后的 call_id（时间序）；多于 1 个说明 trace_id 匹配带进了其他通话
      trace_ids: [string]   # 去重后的 trace_id，桥接回日志/链路
  summary: "env=staging call_id=xxx 时间窗 [...] 返回 N 条信令，已接通 PDD Xms / 未接通，错误响应 Y 个（混入多通话时附「涉及 M 个 call_id」）"
  confidence: 0.8（有消息）/ 0.4（无消息）
  refs: [...]
```

查询失败时 `confidence=0`，`data.error` 包含错误原因。

**多通话边界**：当 `summary.call_ids` 多于 1 个时，`milestones`、`pdd_ms`、`error_responses` 和首尾时间都是所有命中消息的聚合结果，只能用于发现“查询混入了多通话”，不能直接作为任一单通话的接通或 PDD 结论。必须先按 `call_id` 分组还原各自时序，再分别计算和解释里程碑；无法拆清时明确标注不可判定。

## 推荐链路

1. `callId` 直查信令流，看时序与响应码，定位断点（未到达 / 被拒 / 振铃未接 / 异常挂断）。
2. 从 `data.summary.trace_ids` 桥接回应用层：拿 trace_id 交给 log-analyzer（`filters: ["trace_id=xxx"]`）与 trace-analyzer 对齐。
3. 反向桥接：从 `k8s_logs` 的 `not_expand` 桥接出 callid 后回查信令层，对齐应用日志时间线。
4. `k8s_logs` 查不到该 callid 的应用日志属正常（纯 SIP Call-ID 无应用日志关联），以信令分析为准。

## 使用提示

1. `sip_method` 混合方法名与响应码：纯三位数字是响应码（`180`/`200`/`487`），其余是方法名。
2. 401 是 digest 认证质询（正常流程步骤），不计入 `error_responses`；407 目前仍计入。
3. 纯 REGISTER 流程没有 INVITE，`milestones` 为空、无 PDD 属正常。
4. 486/487 要结合 `CANCEL` 与 `BYE` 的先后判断是主叫放弃还是被叫拒绝。
5. 时间窗默认 24h；更早的通话显式传 `start`/`end` 放宽。
6. 需要给人看的 PCAP 抓包文件时走外部 novo-grafana 工具（本项目不生成二进制 PCAP）。

## 检查清单

- [ ] 时间窗是否覆盖通话发生时段（默认 24h，老通话需要显式放宽）。
- [ ] 是否还原了 INVITE→180→200→BYE 完整时序并指出断点。
- [ ] `summary.call_ids` 多于 1 个时，是否先按 call_id 分组重算时序，并避免引用全局 milestones/PDD 作为单通话结论。
- [ ] ≥400 的响应码是否都已解释。
- [ ] 是否用 `summary.trace_ids` 桥接回应用层日志/链路。
