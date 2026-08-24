---
name: tapd-inspector
description: 查询 TAPD 缺陷单（sentry_query_tapd）：按时间窗/状态/严重度/处理人过滤缺陷列表，或取单条完整详情。排障时做"现象 × 已知缺陷"对账，判断症状是否已知问题、是否已有修复在路上。
---

# TAPD 缺陷单查询（tapd-inspector）

## 定位

缺陷单是排障的**背景证据腿**，不是实时观测面。它回答的问题是：

- 这个现象是不是**已知缺陷**？（标题/描述匹配症状）
- 如果是，**什么状态**？谁在处理（current_owner）、有没有解决方案（resolution）、修复人是谁（fixer）
- 故障窗口内**新报的缺陷**有没有集中出现（时间窗过滤）——多张同症状缺陷单同时涌入是故障面扩大的信号

## 工具

`sentry_query_tapd`（只读），两种模式：

| 模式 | 参数 | 返回 |
|---|---|---|
| 列表 | 省略 `id`，用 `status/severity/owner/title/createdStart/createdEnd/limit` | 工单摘要行（id/title/status/severity/owner/created/modified），modified 倒序 |
| 详情 | `id` | 完整工单（含 description/resolution/fixer/deadline） |

## 推荐排查动作

1. **拿到症状先对账**：用症状关键词（服务名 + 错误现象）做 `title` 模糊匹配，再按 `createdStart` 限定故障窗口起——命中即"已知缺陷"分支，结论应引用缺陷 id 和状态。
2. **窗口内新增缺陷**：`createdStart=故障开始日` 看有没有同症状集中上报（用户侧感知的间接证据）。
3. **修复在途的缺陷**：状态 in_progress/resolved 且 resolution 非空的，与部署时间线（zadig 腿）对照——"修复这个缺陷的版本发了吗"是根因判定的常见收尾动作。

## 边界与已知限制

- TAPD 为平台级数据源（不随环境切换）；`workspaceId` 固定在组装配置里
- **权限模型**：个人令牌的权限跟账号的项目角色走。列表/详情 403（"doesn't have permission bugs::list"）说明账号不在该项目或缺缺陷查看权限——如实把错误证据给用户，请其联系项目管理员，**不要**用 count 之类边缘接口的数据冒充缺陷内容
- 时间字段为 TAPD 本地格式字符串（`2026-08-24 10:00:00`），入参用 `YYYY-MM-DD` 或完整时间；对账时注意与日志/指标的 UTC 锚点区分
- 缺陷单内容是**人写的描述**，可信度低于日志/链路等机器证据：缺陷单说"已修复"不等于线上已恢复，必须与观测数据交叉验证后才能进结论
