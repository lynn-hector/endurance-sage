# dsh-im 使用指南（IM 渠道的会话与工作区）

本地 `apps/profile` 内置 `@xmanrui/dsh-im`，把 DSH 接入飞书、钉钉、企微等 IM。统一的 `@dsh-sentry/sentry` npm bundle 只包含 sentry 能力，不强制安装 IM；通过 GitLab 安装的用户如需 IM，应在目标 profile 中单独安装并配置 dsh-im。

本文说明 dsh-im 在**会话复用**和**工作区切换**上的实际行为，依据当前工作区安装的 5.6.0 源码（`src/channels/shared/workspace-session.mjs` 与各渠道 bridge）。

## 会话是复用还是新建？

**默认复用，不会每次新建。**

dsh-im 为每个聊天（群/私聊，即 conversation key）持久维护一条「聊天 → Harness 会话」映射（state-store 的 `sessions` 表，落盘保存）。每条消息进来：

1. 查到映射、且会话在 Harness 侧仍存在 → **复用旧会话**，上下文连续；
2. 查不到、或会话已失效 → **新建会话**并写回映射。

只有这四种情况会新建会话：

| 触发 | 说明 |
|---|---|
| 首次对话 | 该聊天第一次发消息 |
| `/new` | 用户主动清除映射（见下节） |
| 会话失效 | 映射的会话已被删除/归档，`sessionExists` 返回 false |
| 工作区切换 | 旧会话属于原工作区，切换后自动在新工作区**新建空会话**（`WORKSPACE_SESSION_STALE` 重试，对用户透明；旧会话仍保留在原工作区，可 `/session <ID>` 绑回） |

会话绑定有锁保护（`withSessionBindingLock`），并发消息不会为一个聊天创建出两个会话。

## `/new`：开启全新会话

聊天里发 `/new`，或 `/menu` 菜单卡片上点「新会话」。行为：

- 只是**清除映射**，不立即建会话——随后第一条普通消息才真正创建新会话；
- **有任务在跑时会被拒绝**（「当前任务仍在运行…」），需先 `/stop` 或等任务完成；
- 模型/预设的切换只影响新建会话——当前聊天已有会话时，先 `/new` 再发消息才生效。

## `/workspace`：切换工作目录

```text
/workspacelist              # 列出已登记工作区（带序号，标出当前）
/workspace 2                # 按序号切换
/workspace /home/user/novo-commctl   # 按绝对路径切换
```

也可以在 `/menu` 菜单卡片的工作区区域直接点选（与命令等价）。

- 路径必须是**绝对路径**且为真实存在的目录（会做 `realpath` 规范化），相对路径被拒绝；
- 切换成功回复「工作区已切换为：…」；
- 切换后**不需要手动 `/new`**——旧会话自动失效，下一条消息会在新工作区**新建一个空会话**（上下文不带过来）；旧会话仍留在原工作区，切回后可 `/session <会话ID>` 绑回。

⚠️ **工作区是机器人级共享的**：`switchWorkspace` 切的是 bot 的当前工作区，同一 bot 下所有聊天共享。多个群共用一个机器人时，A 群切了工作区，B 群也会受影响。需要隔离就给不同用途接不同 bot 实例（dsh-im 支持 multi-bot）。

## 相关命令速查

| 命令 | 作用 |
|---|---|
| `/menu` | 打开功能菜单卡片（会话/工作区/模型/预设） |
| `/new` | 清会话映射，下条消息开新会话 |
| `/sessionlist [--limit N] [工作区序号\|绝对路径]` | 列出会话 |
| `/session <会话ID\|当前工作区序号>` | 手动绑定到指定已有会话 |
| `/workspacelist` / `/workspace <序号\|绝对路径>` | 列出/切换工作区 |
| `/compact` | 压缩当前会话上下文 |
| `/stop` | 停止当前任务 |
| `/status` | 查看机器人状态（含当前工作区） |

## 源码指引（排障用）

| 关注点 | 位置（`node_modules/@xmanrui/dsh-im/src/`） |
|---|---|
| 复用/新建判定 | `channels/shared/workspace-session.mjs` 的 `askInWorkspaceSession()` |
| 映射持久化 | `channels/<渠道>/state-store.mjs`（`sessions` 表） |
| `/new` 处理 | `channels/feishu/bridge.mjs`（其余渠道同构） |
| `/workspace` 命令 | `channels/shared/workspace-command.mjs` |
