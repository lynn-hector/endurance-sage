# incident-templates：结构化输出模板

排查流程各阶段的输出模板集合：triage-intake（输入评估）、diagnosis-report（诊断报告）、action-plan（行动计划）、incident-summary（事件摘要）、chat-response（对话回复）。

证据结构不用模板：所有工具统一输出 `{ evidence: {...} }` 信封，字段契约见各技能文档（由 `@dsh-sentry/evidence` 在代码层保证）。

## triage-intake — 用户输入评估

收到故障症状描述后先自检，判断信息是否足以进入排查。

必填维度：受影响对象 / 症状描述 / 时间范围 / 影响范围 / 已知变更 / 关联信息（traceId、错误码等）。

完整度评级：**完整**（6 维度齐）→ 直接排查；**基本可用**（4-5）→ 排查并记录待补问题；**不完整** → 结构化追问（一次问完关键维度，附追问理由）；**无法处理** → 说明原因。

```yaml
triage_intake:
  raw_summary: string
  dimensions:
    affected_object: { present: bool, value: string }
    symptom: { present: bool, value: string }
    time_range: { present: bool, value: string }
    impact_scope: { present: bool, value: string }
    known_changes: { present: bool, value: string }
    references: { present: bool, value: string }
  completeness: complete | usable | incomplete | unprocessable
  missing_critical: [string]
  skill_candidates: [string]    # 初步可能调用的技能，不确定时为空
  next_action: proceed | ask_for_clarification | reject_and_redirect
  clarification_questions:
    - question: string
      reason: string
```

> 原版引用的 `docs/fragments/ask-clarification.md` 在原仓库中实际缺失（记录在案的漂移）；追问时按上述结构化格式输出即可。

## interim-conclusion — 中途结论（证据不足/需用户决策时）

排查中途需要把控制权交回用户的场景：服务名对不上、环境存疑、多个待验证假设
无法自行裁决。**不要**硬套 diagnosis-report（根因未定），用这个轻量形态：

```markdown
## 排查结论（第{{round}}轮）：{{一句话结论}}

已完成的交叉验证（表格，数据源 × 查询 × 结果）：

| 数据源 | 查询 | 结果 |
|---|---|---|
| {{source}} | {{query}} | {{result}}（confidence 如实引用） |

**待你裁决的分叉**（我无法替你选）：
1. {{hypothesis_a}} — 若成立，下一步：{{next_a}}
2. {{hypothesis_b}} — 若成立，下一步：{{next_b}}

顺带的观察（不构成因果结论）：{{observation}}
```

要点：只列已验证事实；分叉必须给出"选它之后我做什么"；观察项显式声明
不构成结论。

## 时间呈现规范（所有模板通用）

- **查询与 evidence 锚点一律 UTC + ISO8601**（`2026-08-24T10:00:00Z`）——
  与 GreptimeDB/Prometheus 的存储时区对账，不转义、不本地化
- **面向用户的叙述时间双标**：UTC 在前（证据锚点），括注北京时间
  （`10:00–10:30 UTC（北京时间 18:00–18:30）`）；用户口述的"10 点"先确认
  是哪个时区再入窗，不要默认

## diagnosis-report — 诊断报告（根因确认后）

```markdown
# 诊断报告：{{service}} {{symptom}}

## 基本信息
- 服务 / 环境 / 症状 / 时间窗 / 影响范围 / 严重级别

## 证据摘要
- **{{type}}**：{{summary}}（逐条对应工具返回的 evidence）

## 根因
{{root_cause}}

## 根因类别 / 受影响服务 / 时间线（时间：事件）

## 置信度
{{confidence}}   # 必须给出，配合替代假设

## 替代假设
- {{alternative_cause}}
```

## action-plan — 行动计划

```markdown
# 行动计划：{{service}}

## 立即止损
- [ ] **{{action}}**（负责人：{{owner}}）— 预期效果：{{expected_effect}}

## 验证步骤
- [ ] **{{step}}** — 成功标准：{{success_criteria}}

## 长期修复
- [ ] **{{fix}}**（优先级：{{priority}}）

## 回滚方案
{{rollback_plan}}

## 沟通要点
{{communication_notes}}
```

## incident-summary — 事件摘要

```markdown
- **事件** / **服务**（环境）/ **时间窗** / **影响范围** / **严重级别**
- **根因** / **置信度** / **当前状态** / **跟进人** / **下一步**
```

## chat-response — 对话回复

收集信息阶段：先复述已记录的信息（服务/环境/症状），再列出还需要确认的问题。

进入排查阶段：说明将基于 defect-troubleshooting 方法论调度哪些技能、预计步骤，然后执行。

## 使用原则

- 模板变量用实际内容填充；没有的信息标注"未知"，不要编造。
- diagnosis-report 和 action-plan 必须在根因经交叉验证后输出（见 defect-troubleshooting 第 2.8 节红线）。
- 所有变更类建议必须带验证标准和回滚方案。
