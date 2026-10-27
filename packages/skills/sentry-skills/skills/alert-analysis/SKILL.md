---
name: alert-analysis
description: 飞书告警文本 → 环境切换 → Alertmanager 总览 → 规则表达式下钻 → 指标/日志/Zadig 交叉验证 → diagnosis-report。收到告警卡片（FIRING/恢复、含集群与告警名称字段）或「告警分析/alert」请求时加载。
---

# alert-analysis：飞书告警分析

从飞书告警卡片（或等价告警文本）到诊断报告的固定编排。收到 FIRING/恢复告警、「告警分析」请求时按本流程走；每步列工具与判断标准，证据进 evidence 信封。

## 输入契约

告警卡片样例（YeastarOps 飞书格式）：

```
🚨【YeastarOps】• L2 • GoGrpcP95LatencyHigh • 告警中:1
告警名称 : GoGrpcP95LatencyHigh
告警级别 : L2
集群     : dev-platform-hosted-1
告警状态 : FIRING
开始时间 : 2026-10-10 15:14:53
告警描述 : 【业务监控-Go端】gRPC 服务端 P95 耗时超过 1 秒（阈值 1s，5 分钟窗口，连续 3 个周期）…当前：2.124999999999999s
```

必提取：集群、告警名称、告警级别、开始时间、状态、描述里的阈值/窗口/当前值。缺维度按 triage-intake 一次问全。

## 步骤 0：环境对齐（先做，否则全部证据作废）

集群名即环境名：`dev-platform-hosted-1` 直认，短码 DP1 等价。`sentry_env_switch` 切换 → `sentry_env_current` 复核；已在目标环境则跳过。

## 步骤 0.5：Alertmanager 总览

`sentry_list_am_alerts` 看全局 firing 面：

- **关联告警**：同服务/同集群的其他告警 → 指向共同根因（如一次发布打挂多条规则）；
- **告警风暴**：大量并发 → 优先怀疑基础设施/公共依赖，而非单规则语义；
- `ends_at` 已过 → 大概率已恢复，后续验证自愈即可；
- `sentry_list_am_silences` 确认没有静默干扰通知链路（静默不灭火，只断通知）。

## 步骤 1：规则定位

`sentry_get_alert_rule(name=告警名称)` → 表达式（`query`）、for 时长（`duration`）、labels、分组维度。**表达式只在 Prometheus rules，Alertmanager 没有——不要找错地方。** 同名规则跨 group（L1/L2 各一条）时，用告警描述里的阈值/窗口文本比对选中（如「阈值 1s，5 分钟窗口，连续 3 个周期」对应 query 里的 `> 1`、`[5m]` 与 duration 180）。

## 步骤 2：表达式下钻（谁超了）

从表达式提取核心指标与 `by (...)` 分组标签，构造去阈值的 `topk` 变体（如 `histogram_quantile(...) > 1` → `topk(10, histogram_quantile(...))`）：

1. `sentry_query_metrics` **time 模式**（`time` = 告警触发时刻）精确打点：找出超阈值维度组合与**精确命中告警当前值**的序列（精确匹配告警描述里的小数最能确认口径）；
2. 再用 range 模式（窗口告警开始 ±15 分钟，step 60–120s）看命中序列的时间线：劣化起点、是否持续、是否已回落。

## 步骤 3：量质分离

对热点序列查 counter 的 `increase(...[5m])` 或原始 counter 值曲线：

- **量突增**：QPS 上去把分母撑大/资源打满 → 查容量与上游；
- **单请求变慢**：量不变值变大 → 查下游依赖与代码路径；
- **低频接口 P95 样本量陷阱**：每窗口仅个位数请求时 P95 ≈ 最慢单请求，几个慢请求即可触发告警；用 counter 原始值跳变（相邻采样差）定位慢请求发生的**精确分钟**。

## 步骤 4：日志交叉

**服务名三方映射**：gRPC 标签 `com.yeastar.novoone.<短名>.<Svc>Service` → 短名（`cconfig`）→ workload_name（`commctl-config`）。已知映射：`cconfig→commctl-config`；Java 平台服务：Zadig 模块 `novo-one/platform` → 仓库 `novo-platform-backend`（代码检索的 `repo` 参数用仓库名，勿传模块名/服务名）。**短名与 workload 不总是字面相等**（`commctl-` 前缀），不确定时先 `sentry_list_log_services` 按短名模糊探测。

查询：`sentry_query_logs`，窗口告警开始 ±5–10 分钟；先 `level=ERROR`（ERROR/WARN 双级别用 `filterOr`，如 `filterOr: ["level=ERROR","level=WARN"]`），无结果放宽；同时查该窗口**全集群** ERROR 计数区分「错误风暴」与「慢但成功」（后者日志往往干净）。

## 步骤 5：变更交叉（发布引入？）

`sentry_query_zadig(service=映射后的服务名)` 取最近部署。**镜像 tag 解读**：`<构建时间 yyyymmddHHMMSS>-<构建号>-<版本>[-<profile>]`，如 `20261010150849-5505-264.0.2.1-temp-build` = 2026-10-10 15:08:49 构建、构建号 5505、临时版本。构建/部署时间与劣化起点的时间吻合度是「发布引入」的核心证据；`temp-build`/`dev` 等 profile 后缀提示环境性质（dev 环境的临时构建多为测试验证）。

## 步骤 6：结论输出

按 incident-templates 的 diagnosis-report：证据表（数据源 × 查询 × 结果 × confidence）、根因判定与置信度（按证据链完整度给，交叉验证越多越高）、恢复类告警补「是否自愈 + 恢复时刻」（AM `ends_at` 与指标回落时间互证）。

## 时区纪律

告警文本时间为 **CST（UTC+8）**，工具参数一律 **UTC ISO8601**。每次换算显式写出：`15:14:53 CST = 2026-10-10T07:14:53Z`。换算错了整条时间线全错。

## 红线

只诊断不建议执行：不给重启/回滚/扩缩容指令，仅陈述选项与依据——执行归人。
