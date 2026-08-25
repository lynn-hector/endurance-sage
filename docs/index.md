# 文档地图

按"我想做什么"找入口。

## 日常使用

| 我想… | 看这里 |
|---|---|
| 启动 / 挂载这套插件（headless 或 web GUI） | [guides/runbook.md](guides/runbook.md) |
| 在多个环境间切换（不重启不断会话） | [guides/env-switching.md](guides/env-switching.md) |
| 换 token / 加凭据 / 挂新插件包 | [guides/credentials.md](guides/credentials.md) |

## 了解设计

| 主题 | 看这里 |
|---|---|
| git-guard 危险命令双层门禁（A+B 架构、规则分级、局限） | [architecture/git-guard.md](architecture/git-guard.md) |

## 数据源对接档案

| 数据源 | 看这里 |
|---|---|
| TAPD 缺陷单（背景证据腿） | [integrations/tapd-integration.md](integrations/tapd-integration.md) |

## 事件档案（排查记录，事后追溯用）

| 事件 | 看这里 |
|---|---|
| Zadig token 认证 401（dex 会话 token vs OpenAPI token、CLI 版本坑） | [incidents/2026-08-25-zadig-token.md](incidents/2026-08-25-zadig-token.md) |

新事件建议命名 `incidents/YYYY-MM-DD-<主题>.md`。

## 权威数据源（不是文档，但常被找）

- 环境矩阵（endpoint、凭据键名）：`apps/agent/envs.yml`（唯一手工维护点）
- 项目背景 / 服务清单（skill 内容）：`packages/skills/sentry-skills/src/skills/project-context.md`
