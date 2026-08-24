# 端到端演练（Phase 5，方案 A：真机）

场景来源：`endurance-sentry/tests/fixtures/sample-incident.yml`。
目的：验证 persona → 方法论加载 → triage → 工具调度 → 证据交叉验证 → 模板输出
的完整闭环第一次真实连转。

## 前提状态

| 链路 | 状态 |
| --- | --- |
| 组装文件 | `apps/agent/sentry.cordis.patch.yml`（16 插件，依赖序），已同步到 web profile |
| 日志（GreptimeDB） | ✅ 凭据已配，真实可达 |
| 代码（rg/codegraph） | ✅ baseDir 指向本机仓库 |
| 链路（Grafana Jaeger） | ⚠️ 需在 `.credentials.yaml` 补 `GRAFANA_LOCAL_USERNAME/PASSWORD` |
| DB / Redis（dbx） | ⚠️ 需补 `DBX_REDIS_PASSWORD`（一个引用同时服务 db/redis） |
| MQ（RocketMQ Console） | ⚠️ 需补 `ROCKETMQ_CONSOLE_PASSWORD`；console 在 cn-0.test 域 |
| 指标（Prometheus） | ❌ 无真实远程端点（原项目也只有 localhost 模板值） |
| Zadig | ❌ 占位 endpoint（原项目模板值） |

未配凭据/占位的链路**不是演练阻塞项**：预期行为是工具返回 `confidence: 0` 的
错误证据、模型如实说明"这个数据源看不到"，而不是编造——这本身是验收点。

## 启动

重启 web（profile 会加载完整组装），确认目录里 13 个 skill、工具列表含
`sentry_query_logs / sentry_fetch_trace / sentry_query_metrics / sentry_list_alerts /
sentry_query_db / sentry_query_redis / sentry_query_zadig / sentry_query_mq /
sentry_search_code / sentry_read_code`。

## 主演练话术（贴进对话框）

> order-service 从今天 10:00 开始大量 503，影响全部用户，P1。
> 时间范围 10:00–10:30（UTC）。帮我排查根因。

（对齐 fixture：symptom/service/timeRange/scope/severity 五要素齐全，
对应 triage 完整度评级"完整"，预期不追问直接进排查。）

## 追问演练（第二句，验 triage 不完整分支）

> 系统好像有点问题，能帮我看看吗？

预期：persona + triage-intake 生效——结构化列出缺失维度（对象/症状/时间/范围），
一次问完，**不**无目标乱查。

## 验收清单

- [ ] persona：先收敛范围/列假设再动手，没有上来就猜根因
- [ ] 加载了 defect-troubleshooting（10 步框架痕迹）与 project-context（服务边界认知）
- [ ] triage：主话术不追问；模糊话术结构化追问
- [ ] 工具调度顺序合理：日志先行（唯一就绪的观测面）→ 拿 trace_id/错误码
- [ ] 未配凭据链路：错误证据如实呈现，结论置信度随之收敛，**没有编造**
- [ ] 代码定位：从日志错误文案/SQL 调 sentry_search_code → sentry_read_code
- [ ] 结论：至少两类证据交叉验证；给不出则明说"待验证假设"+ 缺什么
- [ ] 输出形态：diagnosis-report / action-plan 的字段结构（置信度、替代假设、回滚方案）
- [ ] 全程中文，技术标识保留原文；无越权写操作建议

## 已知边界（记录在案，不算失败）

- Prometheus/Zadig 无真实端点 → 指标拐点与"是否发布引入"两条腿本次走不通
- fixture 的 `method: general-troubleshooting` 引用的是原仓库缺失文件（漂移已记录），
  实际应加载 defect-troubleshooting
- fixture 的 order-service 是虚构服务：project-context 里没有它，预期模型会指出
  "该服务不在已知服务清单"——这恰好验证项目知识层在工作
