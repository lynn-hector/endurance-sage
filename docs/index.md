# 文档地图

按"我想做什么"找入口。

## 日常使用

| 我想… | 看这里 |
|---|---|
| 我是新同事，从零接入（含 dsh 宿主、模型、凭据） | [guides/onboarding.md](guides/onboarding.md) |
| 启动 / 挂载这套插件（headless 或 web GUI） | [guides/runbook.md](guides/runbook.md) |
| 在多个环境间切换（不重启不断会话） | [guides/env-switching.md](guides/env-switching.md) |
| 换 token / 加凭据 | [guides/credentials.md](guides/credentials.md) |
| 给 sentry profile 加/换插件（第三方与自研分型） | [guides/onboarding.md](guides/onboarding.md) 的「给 sentry profile 加插件（SOP）」 |
| 部署到远程服务器（免手改路径） | [guides/deploy.md](guides/deploy.md) |
| 开发完成后的验证、本地安装、GitLab 发布与安装 | [guides/development-release-install.md](guides/development-release-install.md) |

## 了解设计

| 主题 | 看这里 |
|---|---|
| 系统总览：dsh 与 dsh-sentry 的关系、分层架构、装配管线、代码检索闭环 | [architecture/overview.md](architecture/overview.md) |
| dsh 宿主装配运行机制（bundle/patch 叠加、注册路线、热重载边界，含官方文档参照） | [architecture/dsh-loading.md](architecture/dsh-loading.md) |
| git-guard 危险命令双层门禁（A+B 架构、规则分级、局限） | [architecture/git-guard.md](architecture/git-guard.md) |
| Env / Session 现行架构：状态归属、持久绑定、Provider 池、恢复与验收 | [architecture/session-env-routing.md](architecture/session-env-routing.md) |
| 目录职责：apps 与 packages 的边界及各文件作用 | [apps/README.md](../apps/README.md) |

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
- 项目背景 / 服务清单（skill 内容）：`packages/skills/sentry-skills/skills/project-context/SKILL.md`
