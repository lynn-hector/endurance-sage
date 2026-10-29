# TAPD 对接档案（dsh-sentry 第 8 条证据腿）

> 状态：**已上线**（代码全绿，MCP 通道真机验证）· 2026-08-25
> 定位：缺陷单是排障的**背景证据**——"现象 × 已知缺陷"对账，判断症状是否已知问题、修复是否在途。

## 1. 链路

```
排障对话 ──▶ sentry_query_tapd (tool-tapd-inspector)
                │ evidence 信封（confidence / refs / 错误即证据）
                ▼
            ctx.tapd (service-tapd, Cordis 服务)
                │ Bearer 个人令牌 + MCP 通道标记
                ▼
            https://api.tapd.cn  ·  workspace 63822673（NovoOne-ITSP）
```

| 层 | 包 | 职责 |
|---|---|---|
| service | `packages/services/tapd` | HTTP 客户端、envelope 校验、短 id 补长、评论解包 |
| tool | `packages/tools/tool-tapd-inspector` | `sentry_query_tapd`：列表（过滤）/ 详情（含评论）|
| skill | `packages/skills/sentry-skills/skills/tapd-inspector/SKILL.md` | 何时查、对账策略、可信度边界 |
| 组装 | 平台级条目（同 Zadig）：`workspaceId: '63822673'` + `tokenRef: TAPD_TOKEN`，不随环境矩阵切换 |

## 2. 能力

| 模式 | 参数 | 实测 |
|---|---|---|
| 列表 | `status` / `severity` / `owner` / `title`(模糊) / `createdStart/End` / `limit≤200` / `orderBy` | ✅ 全部有效；默认 modified 倒序，`priority desc` 可按优先级 |
| 详情 | `id`（长 id 直传，≤9 位短 id 自动补 `11<ws><9位>`）| ✅ 全字段 + **评论（测试反馈/流转备注）** |
| 探针 | `bugs/count` | ✅ 连通性检查（4684）|

## 3. 踩坑记录（按发现顺序，全部真机验证）

### 3.1 双通道权限模型（最关键，折腾最久）

TAPD 缺陷读取有**两套权限路径**：

| 通道 | 端点 | 认证要求 | 表现 |
|---|---|---|---|
| 经典 OpenAPI | `/bugs/list`、`/bugs/get` | 企业级 API 权限 | 个人令牌一律 403，**与网页可见性无关** |
| MCP 通道 | `GET /bugs` + `Via: mcp` 头 + `s=mcp` 参数 | 个人令牌即可 | ✅ |

排障过程（反面教材值得记）：
1. 403 → 以为账号不在项目 → 用户网页能看到，排除
2. 以为令牌固化角色快照 → 换新令牌同结果，排除
3. 读官方 MCP server（`mcp-server-tapd`，pip 包）源码，发现 `Via: mcp` + `s=mcp` 标记 → curl 复刻，`users/info` 通但 `bugs/list` 仍 403——**标记不够**
4. 用户在 Cursor 用同令牌配置 MCP 成功 → 对照实验锁定差异在**端点**：MCP server 调的是 `/bugs` 而非 `/bugs/list` → 通

**教训**：排除法走到"请求构造差异"时，读客户端源码比猜权限模型快。同令牌同账号，一端点 403 一端点 200，就是端点级权限。

### 3.2 评论的 entry_type 陷阱

`GET /comments` 的 `entry_type` 必须填 **`Bug`**（单数、首字母大写）。填文档惯用的 `bugs`：
**返回 200 + 空数组，静默失败**——不报错，极易误判为"没有评论"。验证方法：拿一张网页上明确有评论的单子做对照。

### 3.3 其他 quirk

- **响应包裹**：行是 `{Bug: {...}}` / `{Comment: {...}}` 实体包裹，service 层解包
- **成败不在 HTTP 状态码**：body envelope 里 `status: 1` 才是成功（HTTP 可能 200）
- **severity 取值**：`serious` / `normal`（小写），不是 High/Middle
- **长 id 格式**：`11` + workspace_id + 9 位补零序号；本项目序号实际 7 位（如 `1158456`），从尾部数 6 位拼 id 会错
- **`priority_label` 与 `priority` 排序等效**

## 4. 凭据

- 键：`TAPD_TOKEN`（平台级裸键，`~/.dsh/.credentials.yaml`）
- 个人令牌，权限跟账号项目角色走；获取路径：我的设置 → 个人访问令牌
- ⚠️ 会话中粘贴过令牌明文，**演练结束后轮换**

## 5. 与 MCP 的关系（决策记录）

评估过用 `dsh-mcp-client` 挂官方 `mcp-server-tapd` 替代自建：**否**。理由：
- 官方 MCP 走同一 OpenAPI、同一权限（它本身就是 MCP 通道标记的出处）
- 自建腿有 evidence 信封纪律（confidence/refs/错误即证据）、skill 集成、测试治理
- 结论：**MCP 适合快速接入没建过腿的数据源；已建原生腿的，MCP 是降级不是升级**
- 但官方 MCP 的源码是 quirk 情报来源（`Via: mcp` 就是从它源码里读出来的）

## 6. 待办

- [ ] web 冷加载重启后，会话内 `sentry_query_tapd` 生效（当前会话挂的还是旧实现，curl 层已验证）
- [ ] severity 过滤的项目实际取值集合校准（skill 里已提示）
- [ ] 会话后令牌轮换
- [ ] 可选：`/bugs/status_map`（状态流转字典）——经典通道 403，未在 MCP 通道验证

## 7. 变更历史

| commit | 内容 |
|---|---|
| `adf6321` | 初版：经典端点（/bugs/get|list），权限 403 阻塞 |
| `8f2f305` | 切换 MCP 通道（/bugs + Via mcp + s=mcp），个人令牌可读 |
| `d5ff0fd` | 详情模式带评论（entry_type=Bug 陷阱修复）|
| `5ac1c3d` | orderBy 支持（priority desc 实测）|
