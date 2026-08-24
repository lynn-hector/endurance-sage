# 多环境切换指南

dsh-sentry 支持在**一个不重启、不断会话**的 web GUI 里排查多套环境。原理：dsh 的 profile patch 层是热重载的（文件一变，插件就地以新配置重建），所以切环境 = 换写一份组装文件。

## 三个文件，各司其职

| 文件 | 角色 | 你会不会手改 |
|---|---|---|
| `apps/agent/envs.yml` | **唯一事实来源**：每环境一行（endpoint + 凭据键名 + 数据源 uid） | 会——加环境、改端点都在这 |
| `apps/agent/src/{render,use-env}.ts` | 渲染器与切换器 | 不会 |
| `~/.dsh/profiles/web/cordis.patch.yml` | 当前生效的生成物（被 dsh watch） | 不会——切环境自动覆盖 |

凭据值本身放 `~/.dsh/.credentials.yaml`（键名 = envs.yml 里的 `*Ref` 字段），永远不进 repo。

## 日常命令

```bash
# 查看环境与就绪度（缺哪个凭据键一目了然）
pnpm --filter @dsh-sentry/agent run use-env --list

# 切换环境（写入 web profile，watcher 热重载；web 不重启、对话不中断）
pnpm --filter @dsh-sentry/agent run use-env dev-platform-hosted-0
pnpm --filter @dsh-sentry/agent run use-env dev-platform-hosted-1

# 预览某环境的完整组装（不写入）
pnpm --filter @dsh-sentry/agent run use-env dev-platform-hosted-1 -- --dry-run

# 重新生成 repo 内的默认环境组装（dev-platform-hosted-0）
pnpm --filter @dsh-sentry/agent run regenerate
```

**就绪度门**：切换前校验该环境引用的全部凭据键（8 个）在凭据库或进程环境中存在，缺任何一个直接拒绝并列出键名。**补齐凭据 = 启用环境**，矩阵不用动。

## 当前环境矩阵（实测状态）

| 环境 | 域名族 | 状态 | 备注 |
|---|---|---|---|
| `dev-platform-hosted-0` | cn-0.dev.novo-one.com | ✅ 就绪 | 七条腿全实测 |
| `dev-platform-hosted-1` | cn-1.dev.novo-one.com | ✅ 就绪 | 五条腿全实测 |
| `dev-client-hosted-0` | cn-0.dev-byoi.novo-one.com | ⛔ 缺 `GRAFANA_CH0_PASSWORD` | 该实例禁用 basic auth；service account Bearer token 已建好待入库 |

跨环境共享的凭据事实（实测）：
- greptimedb 三环境同凭据（`grafana` 用户，键 `GREPTIMEDB_LOCAL_*`）
- dbx / rocketmq / zadig 凭据跨环境复用
- grafana 每环境独立密码（admin）
- Jaeger 数据源 uid 随环境漂移（PH0 是 `GreptimeDB-Jaeger`，PH1 是 `PCD48328C06B18945`）——矩阵里是每环境字段
- zadig 用 dex 会话 token（`ZADIG_DEX_TOKEN`），约 1 小时过期，从浏览器刷新后覆盖入库；过期后 zadig 工具以 401 错误证据回报，不影响其他腿

## 新增一个环境（示例）

1. `envs.yml` 加一行（环境名与 Zadig 环境标识一致），endpoint 按该环境域名族填，凭据键名按 `<SYSTEM>_<ENV>_<FIELD>` 命名；
2. 往 `~/.dsh/.credentials.yaml` 补对应键值；
3. `use-env --list` 确认就绪 → `use-env <环境名>` 切换。

## 试一试：五分钟体验热切换

1. 确认 web GUI 开着（当前停在某环境的会话里，随便哪个对话都行）；
2. 终端执行：
   ```bash
   pnpm --filter @dsh-sentry/agent run use-env dev-platform-hosted-1
   ```
3. **不刷新不重启**，直接在原对话里问一句：「现在 sentry_query_logs 查 commctl-config 最近 30 分钟的日志量」——
   回来的数据就是 **cn-1** 的（PH1 的 freeswitch-sig 30 分钟约 11.7 万行，流量特征和 PH0 明显不同，可作区分标记）；
4. 再切回来：
   ```bash
   pnpm --filter @dsh-sentry/agent run use-env dev-platform-hosted-0
   ```
   同一个对话里再问一次，数据回到 cn-0。全程会话历史完好。

一个识别当前环境的技巧：问模型「当前 evidence 里的 env 标签是什么」——它来自插件 config，跟着切换走，不会说谎。

## 切换之后怎么验证（三层，从快到慢）

1. **文件层（秒级，不开 web）**：确认 profile 里部署的确实是目标环境
   ```bash
   pnpm --filter @dsh-sentry/agent run use-env --current
   # → profile web 当前部署环境: dev-platform-hosted-1（附切换时间戳）
   ```
   或直接抽查 endpoint：`grep dbx ~/.dsh/profiles/web/cordis.patch.yml` 应出现 cn-1 域名。

2. **模型层（真对话）**：在切换前的**原有对话**里问模型：
   > 查一下 commctl-config 最近 30 分钟的日志量，并告诉我 evidence 里的 env 标签
   `env` 标签来自插件 config、跟随切换走——它是系统自己申报的环境，比人眼检查更可信。

3. **数据层（铁证）**：不同环境的流量特征不同。PH1 的 freeswitch-sig 30 分钟约 11.7 万行日志、PH0 明显更少；两边各查一次对比行数量级，即确认查的是不同集群。

三层都过 = 切换完全生效。若第 1 层已变而第 2 层没变，说明 watcher 热重载有异常——回退方法：重跑一次 `use-env <环境>` 或重启 web。

## 边界与注意事项

- 切换是**运维动作**（你敲命令），不是模型动作：模型永远只能查当前部署的环境，无法在对话里跳环境。
- 切换瞬间正在执行的工具调用可能撞上插件重建，重试即可。
- `sentry.cordis.patch.yml` 是生成物，勿手改（改了也会被下次生成覆盖）；改动请进 `envs.yml`。
