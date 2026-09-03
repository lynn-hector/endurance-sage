# env-switcher：环境查看与热切换

## 使用边界

当用户要求查看当前环境、列出可用环境、切换 TP0/TP1/TC0/SC1/SC2 等环境，或询问“现在连的是哪套日志/接口”时使用这组工具。

触发示例：

- “切到 TP1”
- “现在是什么环境”
- “有哪些环境能用”
- “看看 TC0 的凭据是否齐”

不要为了普通日志、指标、链路查询而主动切换环境；只有用户明确表达切换意图，或排查目标与当前环境不一致并征得用户确认后才切换。

## 工具

### sentry_env_list — 列出环境

无参数。返回：

- `current`：当前生成装配中的环境。
- `environments[]`：环境名、短名、凭据是否就绪、缺失凭据键、GreptimeDB endpoint。

### sentry_env_current — 确认当前环境

无参数。返回：

- `current`：从 `cordis.include.yml`/`cordis.patch.yml` 文件头读取的环境——唯一事实源。
- `loadedEnv`：本插件自身 config 的环境。本插件不注入数据源 service，热重载必然到达它。
- `hotReloadPending`：`true` 表示重载连本插件都没到达（patch watcher 死亡或重载在途），需重启 dsh web 兜底。`false` 不代表所有插件实例都已重启——注入 service 的工具实例可能仍冻结在启动 config（cordis 静默分支），但其 evidence `env` 标签与环境相关参数已改为调用时读装配文件，不受冻结影响；service 插件本身热重载正确。

### sentry_env_switch — 切换环境

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `env` | 是 | - | 环境全名或短名：`DP0`、`DP1`、`DC0`、`TP0`、`TP1`、`TC0`、`SC1`、`SC2` |
| `dryRun` | 否 | `false` | 只返回渲染结果，不写文件 |

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

## 执行原则

1. 不确定环境时先调用 `sentry_env_current` 或 `sentry_env_list`。
2. 用户使用短名时直接传短名，不要自行拼接 endpoint 或文件路径。
3. 切换前工具会校验该环境全部凭据引用；缺任何一个会拒绝写入并返回缺失键名。
4. 切换成功只表示配置文件已更新；随后依赖 dsh patch watcher 热重载，不需要重启。
5. 调用 `sentry_env_switch` 后，用 `sentry_env_current` 确认文件环境；若 `hotReloadPending` 持续为 `true`，提示用户重启 dsh web 兜底。
6. 切换后抽查一次查询的 evidence `env` 标签，应与目标环境一致（标签按调用时读装配文件解析，正常必然一致）；若不一致，说明装配文件不可读，先修复文件再继续。
7. 工具会识别当前 profile 形态：include 桩只更新仓库装配；直写 sentry 装配会同步更新 profile patch。不要手工改路径。

## 输出话术

成功示例：

```text
已切换到 TP1（tst-platform-hosted-1）。配置文件已更新，等待 dsh 热重载；当前会话无需重启。
```

凭据缺失示例：

```text
TP0 暂不能切换，缺少 GRAFANA_TP0_USERNAME、GRAFANA_TP0_PASSWORD。补齐本地凭据库后再试。
```

热重载未生效示例：

```text
文件已经是 TP1，但插件仍显示旧环境。请重启 dsh web 后再查询，避免拿到旧环境数据。
```
