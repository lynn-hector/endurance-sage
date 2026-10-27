# 多环境切换指南

dsh-sentry 的环境路由是 **Session 级绑定**：对话内切换只影响当前会话，其他会话保持原环境；切换不写装配文件、不依赖 patch watcher，也不中断会话历史。绑定会持久化，宿主重启并恢复原会话后继续生效。

## 两类环境状态

| 状态 | 作用 | 修改方式 |
|---|---|---|
| 启动 / 默认环境 | 新 Session，以及旧 Session 没有可用绑定时使用的默认值 | `use-env` CLI 生成装配；`regenerate` 恢复为 DP0 |
| Session 当前环境 | 某次会话后续证据查询实际使用的环境 | 对话内 `sentry_env_switch` |

两者不要混淆：`use-env` 改默认环境不会重绑在线 Session，`sentry_env_switch` 也不会改仓库里的装配文件。

## 配置与状态归属

| 文件 / 状态 | 角色 | 是否手改 |
|---|---|---|
| `apps/agent/envs.yml` | 环境矩阵唯一事实来源：endpoint、凭据引用名、数据源 uid、环境别名 | 会——加环境、改端点都在这里 |
| `apps/profile/cordis.patch.yml` / `cordis.include.yml` | 启动装配与默认环境锚点；环境 Provider 不再作为全局条目写入 | 不手改，由 CLI 生成 |
| DSH Session 日志中的绑定记录 | 每个 Session 的当前环境及恢复依据 | 不手改，由绑定服务维护 |
| `~/.dsh/.credentials.yaml` | 凭据值；装配只保存 `*Ref` 键名 | 补凭据时编辑 |

代码仓库根目录属于环境无关的机器配置，不随 Session 环境切换；其配置与生效方式见 [onboarding.md](onboarding.md) 第 2 步。

## 对话内切换（推荐）

直接在 dsh 对话里说“列出环境”“当前环境”“切到 TP1”即可。模型使用三个工具：

| 工具 | 用途 |
|---|---|
| `sentry_env_list` | 列出 `envs.yml` 中的环境、别名、凭据就绪度和调用 Session 的当前绑定 |
| `sentry_env_current` | 返回调用 Session 的环境、绑定来源、持久化状态和逐腿凭据就绪度 |
| `sentry_env_switch` | 校验目标后只重绑当前 Session；`dryRun: true` 只预检、不改变绑定 |

环境名与别名以 `envs.yml` 和 `@dsh-sentry/env-matrix` 为准，不在文档中另维护一份易过期的清单。工具不接受 endpoint、凭据值或任意文件路径。

切换结果重点看：

- `env` / `previousEnv`：新旧绑定；
- `degradedLegs`：目标环境缺凭据的腿。缺值只降级对应腿，不拦截整个切换；
- `persisted`：绑定是否已确认持久化。若为 `false`，本进程内的新绑定已经生效，但重启后的恢复可能失败，应根据 `persistenceError` 排查。

## CLI：设置启动 / 默认环境

```bash
# 查看环境矩阵与各腿凭据就绪度
pnpm --filter @dsh-sentry/agent run use-env --list

# 为 sentry profile 生成 TP0 启动装配（不改在线 Session 的绑定）
pnpm --filter @dsh-sentry/agent run use-env TP0 -- --profile sentry

# 查看该 profile 装配声明的默认环境；这不是某个 Session 的实时绑定
pnpm --filter @dsh-sentry/agent run use-env --current --profile sentry

# 预览装配，不写文件
pnpm --filter @dsh-sentry/agent run use-env TP0 -- --dry-run

# 重新生成仓库内装配；脚本固定使用 DP0，会重置启动默认环境
pnpm --filter @dsh-sentry/agent run regenerate
```

裸用 `use-env <环境>` 默认写 `web` profile。独立 sentry profile 应显式传 `--profile sentry`，避免写错目标。

## 新增或修改环境

1. 在 `envs.yml` 修改环境行，endpoint 与凭据引用名按该环境实际值填写；
2. 在 `~/.dsh/.credentials.yaml` 补对应键值；
3. 用 `use-env --list` 或 `sentry_env_list` 检查就绪度；
4. 对话内切到目标环境验证。只有需要改变启动默认环境时才运行 `use-env <环境> --profile sentry`。

凭据值为空或空白都视为未配置。补齐某腿凭据不需要重建 Session，也不需要切换其他环境。

## 切换后验证

1. **绑定层**：在原会话询问“当前环境”，确认 `sentry_env_current.current` 是目标环境，且 `persisted` 不是 `false`。
2. **证据层**：执行一次目标环境查询，检查返回 evidence 的 `env` 与数据内容。
3. **隔离层（需要时）**：开两个会话分别绑定不同环境并查询，确认数据和 evidence 不串环境；一个会话切换不影响另一个。
4. **恢复层（需要时）**：重启宿主并恢复原会话，确认无需重传环境即可恢复最后绑定。

进行中的查询仍使用调用开始时的环境快照；切换影响的是该 Session 的后续调用。历史消息与历史 evidence 不会被重写。

## 边界与注意事项

- 环境切换是显式、可审计的模型工具调用；普通证据工具不接受 `env` 参数，不能绕开 Session 绑定临时选后端。
- 无法解析调用 Session 时会明确报错，不会退回某个全局环境。
- Provider 按环境共享并懒创建；会话切换不等于为每个会话复制一套连接。
- TAPD、代码仓库等环境无关能力不随 Session 切换。
- 装配文件仍可用于宿主 patch 热重载，但那不是 Session 环境切换的实现路径。
