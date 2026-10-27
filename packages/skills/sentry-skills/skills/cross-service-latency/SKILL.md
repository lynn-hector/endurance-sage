---
name: cross-service-latency
description: 跨服务延迟排查专项：p99 升高/接口慢/超时增多的排查步骤、典型根因与止损建议。
---

# cross-service-latency：跨服务延迟排查

跨服务、跨组件的高延迟排查方法。涉及多个技能（trace-analyzer、metrics-inspector、db-inspector、redis-inspector、code-repository、mq-inspector）。主方法论见 defect-troubleshooting 技能。

## 常见症状

- p99 延迟升高
- 部分接口响应慢
- 超时增多

## 排查步骤

1. **确认延迟曲线**
   - `sentry_query_metrics` 查询 p50/p95/p99 延迟，确认是整体升高还是尾部升高。
   - 关注延迟开始升高的精确时间点。

2. **分析调用链路**
   - 用 `sentry_fetch_trace` 找到慢 span 和错误 span。
   - 优先检查跨服务调用和下游依赖。

3. **检查基础设施**
   - 慢 span 指向 DB/Redis 时，用 `sentry_query_db` / `sentry_query_redis` / `sentry_query_mq` 进一步确认。
   - 检查 CPU、内存、网络、GC 等指标。

4. **关联代码**
   - 定位慢调用对应的代码路径。
   - 检查是否存在同步调用阻塞、大循环、重复查询。

## 典型根因

| 现象 | 可能根因 |
| --- | --- |
| 尾部延迟高 | 下游依赖偶发慢、GC 停顿、网络抖动 |
| 整体延迟高 | 核心依赖慢、代码性能问题、资源瓶颈 |
| 特定接口慢 | 该接口对应的 SQL/Redis/下游调用慢 |

## 止损建议

- 增加超时和熔断，避免慢依赖拖垮整个服务。
- 限流或降级非核心接口。
- 扩容资源（评估后执行）。
- 修复慢调用代码。
