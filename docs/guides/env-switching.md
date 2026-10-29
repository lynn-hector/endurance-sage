# 多环境切换指南

dsh-sentry 的环境路由是 **Session 级绑定**：对话内切换只影响当前会话，其他会话保持原环境；切换不写装配文件、不依赖 patch watcher，也不中断会话历史。绑定会持久化，宿主重启并恢复原会话后继续生效。

## 环境相关的三个概念

- **装配环境**：`cordis.patch.yml` 里 `sentry.config.defaultEnv` 指向的环境。它用于从环境矩阵生成插件装配，也在本机偏好未设置或失效时作为新 Session 的默认环境。
- **本机默认环境偏好**：凭据库或进程环境中的 `DSH_SENTRY_DEFAULT_ENV`。它优先于装配环境，决定下一个新 Session 实际使用的默认环境。
- **Session 当前环境**：某次会话后续证据查询实际使用的环境。通过对话内 `sentry_env_switch` 修改。

三者不要混淆：修改默认环境不会重绑在线 Session，`sentry_env_switch` 也不会修改默认环境或环境矩阵；修改装配环境不会覆盖有效的 `DSH_SENTRY_DEFAULT_ENV`。

## 配置与状态归属

- `apps/agent/envs.yml`：环境矩阵唯一手工维护源，保存 endpoint、凭据引用名、数据源 uid 和环境别名。
- `packages/core/env-matrix/envs.yml`：由 `pnpm run sync:release` 同步、随 npm 包发布的默认矩阵，不单独手改。
- `packages/bundle/sentry/cordis.patch.yml`：发布用统一 bundle 默认装配，由同步命令生成。
- `apps/profile/cordis.patch.yml` / `cordis.include.yml`：本地 profile 的生成装配，不是 npm 用户的必需文件。
- DSH Session 日志中的绑定记录：每个 Session 的当前环境及恢复依据，由绑定服务维护。
- `~/.dsh/.credentials.yaml`：真实凭据值，装配只保存 `*Ref` 键名。

代码仓库根目录属于环境无关的机器配置，不随 Session 环境切换；配置方式见[新同事上手指南](onboarding.md#第-4-步可选的代码检索腿)。

## 对话内切换（推荐）

直接在 DSH 对话里说“列出环境”“当前环境”“切到 TP1”即可。模型使用三个工具：

- `sentry_env_list`：列出矩阵中的环境、别名、凭据就绪度和调用 Session 的当前绑定。
- `sentry_env_current`：返回调用 Session 的环境、绑定来源、持久化状态和逐腿凭据就绪度。
- `sentry_env_switch`：校验目标后只重绑当前 Session；`dryRun: true` 只预检、不改变绑定。

环境名与别名以环境矩阵为准。工具不接受 endpoint、凭据值或任意文件路径。

切换结果重点看：

- `env` / `previousEnv`：新旧绑定；
- `degradedLegs`：目标环境缺凭据的腿，缺值只降级对应腿；
- `persisted`：绑定是否已确认持久化。若为 `false`，本进程内已经生效，但重启恢复可能失败，应根据 `persistenceError` 排查。

## 修改新 Session 默认环境与装配环境

新 Session 的默认环境以机器本地偏好键 `DSH_SENTRY_DEFAULT_ENV`（本机凭据库或进程环境）为准；该键未设置或失效时，使用装配环境 `defaultEnv`。修改默认环境只影响新 Session，不会重绑在线 Session。

### DSH 设置页

Web 设置面板的「环境与凭据」页会展示**下一个新 Session 实际生效的默认环境**、其来源（本机偏好 `DSH_SENTRY_DEFAULT_ENV` 或装配环境 `defaultEnv`）以及装配环境值，并可直接编辑/清除本机偏好 `DSH_SENTRY_DEFAULT_ENV`。页面不修改装配环境或环境矩阵。已有 Session 的环境仍通过 `sentry_env_switch` 切换。

### 本地工作区

`use-env` 是仓库维护者和本地链接安装用户的 CLI：

```bash
# 查看环境矩阵与各腿凭据就绪度
pnpm --filter @dsh-sentry/agent run use-env --list

# 为 sentry profile 生成 TP0 装配环境，不改在线 Session
pnpm --filter @dsh-sentry/agent run use-env TP0 -- --profile sentry

# 查看 profile 装配声明的装配环境，不是 Session 实时绑定
pnpm --filter @dsh-sentry/agent run use-env --current --profile sentry

# 预览装配，不写文件
pnpm --filter @dsh-sentry/agent run use-env TP0 -- --dry-run

# 重新生成仓库内装配并恢复 DP0 装配环境
pnpm --filter @dsh-sentry/agent run regenerate
```

裸用 `use-env <环境>` 默认写入 `web` profile。独立 sentry profile 应显式传 `--profile sentry`。

### GitLab npm 安装

npm 用户不需要仓库 CLI。可以在对应 profile 的 `cordis.patch.yml` 中覆盖统一入口，例如：

```yaml
- id: sentry
  config:
    defaultEnv: tst-platform-hosted-0
```

保存后重启宿主。该修改调整的是**装配环境**：它决定插件装配按哪个环境行生成，并在 `DSH_SENTRY_DEFAULT_ENV` 未设置或失效时作为新 Session 默认环境；已有 Session 仍使用自己的持久绑定。

npm 用户调整默认环境时有两种入口：

- **调整本机默认环境**：在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下设置 `DSH_SENTRY_DEFAULT_ENV`，优先级更高，下一个新 Session 生效。
- **调整 profile / 团队装配环境**：修改上述 `defaultEnv` 并重启宿主，用于改变装配锚点和无本机偏好时的默认值。

设置页展示最终生效值及其来源，并可编辑本机偏好；装配环境仍按上述 profile 配置修改。

## 新增或修改环境

1. 在维护仓库的 `apps/agent/envs.yml` 修改环境行，并补充本机凭据。
2. 执行 `pnpm run sync:release`，同步包内矩阵和 bundle 装配。
3. 本地链接安装需要更新启动环境时，再执行 `use-env` 或 `regenerate`；仅新增可选环境不需要改默认装配。
4. 用 `use-env --list` 或 `sentry_env_list` 检查就绪度，并在对话内切换验证。
5. 需要让 npm 用户获得新环境时，按标准流程发布新版本；用户升级 bundle 后即可获得更新后的矩阵。

凭据值为空或空白都视为未配置。补齐某腿凭据不需要重建 Session，也不需要切换到其他环境。

## 切换后验证

1. **绑定层**：在原会话询问“当前环境”，确认 `sentry_env_current.current` 是目标环境，且 `persisted` 不是 `false`。
2. **证据层**：执行一次目标环境查询，检查返回 evidence 的 `env` 与数据内容。
3. **隔离层**：需要时开两个会话分别绑定不同环境并查询，确认数据和 evidence 不串环境。
4. **恢复层**：需要时重启宿主并恢复原会话，确认恢复最后绑定。

进行中的查询仍使用调用开始时的环境快照；切换影响该 Session 的后续调用。历史消息与历史 evidence 不会被重写。

## 边界与注意事项

- 环境切换是显式、可审计的模型工具调用；普通证据工具不接受 `env` 参数。
- 无法解析调用 Session 时会明确报错，不会退回某个全局环境。
- Provider 按环境共享并懒创建；会话切换不等于为每个会话复制一套连接。
- TAPD、代码仓库等环境无关能力不随 Session 切换。
- 装配文件仍可用于宿主 patch 热重载，但那不是 Session 环境切换的实现路径。
