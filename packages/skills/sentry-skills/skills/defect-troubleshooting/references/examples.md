# 完整分析示例

本例演示 10 步如何串联，不要求每次使用 YAML、展示所有字段或提出相同数量的假设。示例中的修复仍未到根因确认阶段，因此只记录止损候选，不给确定修复结论。

```yaml
defect_analysis:
  description:
    phenomenon:
      operation: 用户在下单页选择优惠券并点击提交订单
      expectation: 2 秒内完成下单并跳转支付页
      actual: 转圈 10 秒以上，报「系统繁忙」，订单未生成
    impact:
      environment: production
      severity: P0
      severity_basis: 核心下单功能受损
      frequency: 高频偶发
      scope: 客服采样反馈约 20% 请求受影响，全量比例待监控确认
  known_facts:
    - fact: 页面转圈超过 10 秒后报「系统繁忙」
      evidence: 用户截图与客服反馈
    - fact: 部分用户不使用优惠券时下单正常
      evidence: 客服反馈，尚需请求样本验证
  unknowns:
    - question: 所有优惠券还是特定券触发
      impact: 决定检查通用调用路径还是特定数据条件
    - question: 后端错误码、traceId 和准确发生时间
      impact: 决定能否追踪代表性失败请求
  hypotheses:
    - cause: 优惠券抵扣调用发生慢查询或锁等待
      confidence: medium
      basis: 症状与用券路径相关，且表现为长时间等待
    - cause: 优惠券服务超时后未正确熔断或降级
      confidence: medium
      basis: 最终返回通用繁忙错误，需链路验证
  validations:
    - hypothesis: 优惠券抵扣调用发生慢查询或锁等待
      method: 在故障时间窗查询用券请求对应的慢 SQL 与锁等待记录
      supports: 同一请求或时间关联的 SQL 出现长耗时或锁等待
      weakens: 对应请求没有 DB 等待，耗时集中在其他节点
      cost: low
    - hypothesis: 优惠券服务超时后未正确熔断或降级
      method: 查询代表性失败请求的 trace，检查 coupon-service span 耗时与后续处理
      supports: 该 span 超时，且订单请求持续等待直至失败
      weakens: coupon-service 正常返回，异常首先出现在其他节点
      cost: low
  recommended_order:
    - 获取一个失败请求的 traceId，确认首个异常节点
    - 根据异常节点查询慢 SQL、锁等待或下游超时证据
    - 对比正常下单与失败下单的请求路径，验证用券条件的区分度
  needed_info:
    - item: 失败请求 traceId 或精确时间、用户与订单标识
      reason: 关联日志和链路，避免只凭症状猜测
      source: 用户反馈、网关或客服记录
  mitigation_candidates:
    - action: 临时关闭优惠券入口
      status: candidate_not_executed
      tradeoff: 可能快速恢复普通下单，但用户无法使用优惠券
      validation: 普通下单成功率与延迟恢复，且无新增一致性异常
      rollback_plan: 恢复原入口配置并验证配置下发与下单路径
  fix_directions: 根因待验证，暂不给确定修复方向
  post_fix_validation:
    - 原失败用例恢复，无券下单路径不受影响
    - 下单 P99 和错误率恢复至故障前基线
    - 检查是否存在订单已生成但优惠券未扣减的数据
  regression_points:
    - 同一券并发用于两个订单时，仅一个订单抵扣成功
    - 优惠券服务超时时，系统按设计熔断或降级
    - 券面值等于订单金额的边界场景
```
