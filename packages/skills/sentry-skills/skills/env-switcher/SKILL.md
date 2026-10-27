---
name: env-switcher
description: 列出、确认并热切换 dsh-sentry 环境（sentry_env_list / sentry_env_current / sentry_env_switch），支持 DP0/DP1/DC0/TP0/TP1/TC0/SC1/SC2 短名。
---

# env-switcher：环境查看与会话切换

## 使用边界

当用户要求查看当前环境、列出可用环境、切换 TP0/TP1/TC0/SC1/SC2 等环境，或询问“现在连的是哪套日志/接口”时使用这组工具。

触发示例：

- “切到 TP1”
- “现在是什么环境”
- “有哪些环境能用”
- “看看 TC0 的凭据是否齐”

不要为了普通日志、指标、链路查询而主动切换环境；只有用户明确表达切换意图，或排查目标与当前环境不一致并征得用户确认后才切换。

## 语义

环境是**当前会话（Session）的绑定**，不是全局状态：切换只影响本会话后续调用，其他并行会话保持各自环境，已写入历史的证据保持原样。绑定持久化在 Session 日志里，runtime 重启、resume、fork 后自动恢复，无需重传环境。切换不重启、不重建会话，也不写任何共享配置文件。

## 工具

### sentry_env_list — 列出环境

无参数。返回：

- `current`：**当前会话**绑定的环境。
- `environments[]`：环境名、短名、凭据是否就绪、缺失凭据键、GreptimeDB endpoint。

### sentry_env_current — 确认当前环境

无参数。返回：

- `current`：当前会话恢复后的绑定（canonical 环境名）。
- `source`：绑定来源——`tool`（模型显式切换）/ `sdk`（外层初始化）/ `default`（新会话默认）/ `migration`（旧会话无记录补写）/ `recovery`（绑定环境已下线，回退默认并报告 `recoveredFrom`）。
- `readiness` / `degradedLegs`：逐腿凭据就绪度与降级腿。
- `persisted`：最近一条绑定记录的持久化确认（`false` 表示本进程已生效但落盘未确认）。

### sentry_env_switch — 切换环境

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `env` | 是 | - | 环境全名或短名：`DP0`、`DP1`、`DC0`、`TP0`、`TP1`、`TC0`、`SC1`、`SC2` |
| `dryRun` | 否 | `false` | 只校验目标与凭据就绪度，不改绑定 |

成功返回 `previousEnv`、`env`、`changedAt`、`persisted` 与 `degradedLegs`。

短名映射：

| 短名 | 环境 |
| --- | --- |
| `DP0` | `dev-platform-hosted-0` |
| `DP1` | `dev-platform-hosted-1` |
| `DC0` | `dev-client-hosted-0` |
| `TP0` | `tst-platform-hosted-0` |
| `TP1` | `tst-platform-hosted-1` |
| `TC0` | `tst-client-hosted-0` |
| `SC1` | `sit-client-hosted-1` |
| `SC2` | `sit-client-hosted-2` |
| `PBO` | `pro-br-saas-aws-eks-novo` |
| `TPSG0` | `tst-platform-aws-eks-sg-0` |
| `PUO` | `pro-use-saas-aws-eks-novo` |
| `PZO` | `pro-za-saas-aws-eks-novo` |
| `PDO` | `pro-de-saas-aws-eks-novo` |
| `PSO` | `pro-sg-saas-aws-eks-novo` |
| `TPDE0` | `tst-platform-aws-eks-de-0` |
| `TPUS0` | `tst-platform-aws-eks-us-0` |
| `TPAU0` | `tst-platform-aws-eks-au-0` |

## 执行原则

1. 不确定环境时先调用 `sentry_env_current` 或 `sentry_env_list`。
2. 用户使用短名时直接传短名，不要自行拼接 endpoint 或文件路径。
3. 切换前工具按腿校验凭据值；缺值或空值不拦截切换，随结果返回降级腿（`degradedLegs`）与缺失键名，对应工具调用时按需报错。降级腿的连带范围要向用户说全：`grafana` 腿降级 = trace / prometheus / alertmanager 三家工具同时不可用（共用 grafana 账密）；`dbx` 腿降级连带 Redis 查询（经 dbx 中转）。
4. 切换成功即对本会话生效（`persisted: true` 表示已确认落盘）；无需等待热重载，也无需重启。
5. 切换后抽查一次查询的 evidence `env` 标签，应与目标环境一致——每次调用的环境身份在查询前固定，进行中的旧查询仍标注原环境，属正常语义。
6. `persisted: false` 表示本进程已生效但持久化未确认；可重试一次切换或提示用户检查持久化后端，不要谎报已落盘。

## 输出话术

成功示例：

```text
已切换到 TP1（tst-platform-hosted-1），本会话后续查询即走 TP1；其他会话不受影响，绑定已随会话持久化。
```

凭据降级示例：

```text
已切换到 TP0（tst-platform-hosted-0），但 grafana 腿凭据缺失（GRAFANA_TP0_USERNAME、GRAFANA_TP0_PASSWORD），该腿及 trace/prometheus/alertmanager 工具暂不可用。补齐本地凭据库后即恢复，无需重新切换。
```
