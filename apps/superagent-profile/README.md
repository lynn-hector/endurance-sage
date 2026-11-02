# superagent-profile

排障 superagent 的部署装配：**dsh-superagent 接管飞书入口并编排工单，worker Session 使用 sentry 证据工具完成「现象 → 验证 → 根因 → 建议」的排查闭环。** 与 `apps/profile`（直连排障，dsh-im 入口）互不影响，可并行运行。

## 组成

| bundle | 角色 |
|---|---|
| `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` | DSH 宿主与 Web 面板 |
| `dsh-context` | 会话上下文（sentry 依赖） |
| `@dsh-sentry/sentry` | 证据工具集（日志/链路/信令/指标/告警/DB/Redis/MQ/CI/CD/K8s/TAPD/代码），worker 的工具箱 |
| `dsh-superagent` | 协作编排：飞书 Source → Eval → Ticket → Executor，结果回到原飞书话题（`link:` 指向 `../../endurance-sage-nexus`，其 `feat/sentry-tools` 分支已把 sentry 工具加入 worker 白名单） |

本目录手工维护（`cordis.patch.yml`），不属于 `apps/agent/envs.yml` 的生成管线；环境矩阵与凭据仍以那边为权威。

## 运行

```bash
pnpm install                      # 仓库根目录；首次或依赖变更后
# 用 DSH 宿主加载本 profile（与 apps/profile 同法），面板: http://127.0.0.1:3083
```

首次启动后（按 dsh-superagent 的 SETUP.md）：

1. 面板 Sources 里配置 Feishu bot 的 lark-cli；
2. Eval 策略里配 allowed list（先放少数几个人）和评估规则；
3. Prompts 里给 worker 覆盖排障方法论（或依赖 sentry-persona，见下）。

## 已知取舍

- **`dsh-superagent-github` 已禁用**：排障先走飞书入口；需要 GitHub Source 时在 patch 里改回。
- **`sentry-persona` 未显式插入**：sentry 聚合 bundle 自带 persona/skills 的插件树；若发现主 Session（router）受 persona 全局注入影响路由，在 patch 里对 `sentry-persona` 置 `disabled: true`，并把方法论改写进 worker prompt override。
- **两个飞书入口不要指向同一个 bot/群**：本 profile 的 Feishu Source 与 `apps/profile` 的 dsh-im 各用各的 bot 或群，避免同一条消息双路响应。
- sentry 的 `defaultEnv` 起步用 `tst-platform-hosted-0`；worker 可在会话内用 `sentry_env_switch` 按工单切换环境。
