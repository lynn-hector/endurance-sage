# 端到端演练（Phase 5，方案 A：真机）

场景来源：`endurance-sentry/tests/fixtures/sample-incident.yml`。
目的：验证 persona → 方法论加载 → triage → 工具调度 → 证据交叉验证 → 模板输出
的完整闭环第一次真实连转。

## 前提状态

| 链路 | 状态（多环境矩阵就绪，详见 env-switching.md） |
| --- | --- |
| 组装 | `envs.yml` → `use-env` 生成，web profile 当前部署 DP0/DP1（`use-env --current` 确认） |
| 日志（GreptimeDB） | ✅ DP0/DP1 实测 |
| 代码（rg/codegraph） | ✅ baseDir 指向本机仓库 |
| 链路（Grafana Jaeger） | ✅ DP0/DP1 实测（uid 随环境漂移已入矩阵） |
| DB / Redis（dbx） | ✅ 实测 |
| MQ（每环境独立 console） | ✅ DP0/DP1/DC0 登录实测 |
| 指标（grafana 代理） | ✅ 实测；告警接口在代理模式下不可用（已知边界） |
| Zadig | ⚠️ dex 会话 token 约 1h 过期——演练前刷新则活，过期则 401 错误证据 |

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

- 指标告警（sentry_list_alerts）在 grafana 代理模式下永远返回错误证据——部署形态决定
- Zadig：dex token 过期则 401 错误证据；刷新过则可查 DP1 部署列表（注意 envName 随环境）
- fixture 的 `method: general-troubleshooting` 引用的是原仓库缺失文件（漂移已记录），
  实际应加载 defect-troubleshooting
- fixture 的 order-service 是虚构服务：project-context 里没有它，预期模型会指出
  "该服务不在已知服务清单"——这恰好验证项目知识层在工作；此外指标标签 `app` 下也无此服务
- 指标模板按集群现实校准：HTTP RED 指标只有 Java 服务有，commctl（Go）查 qps/latency
  返回空是真实零值（metrics-inspector skill 已写明）
