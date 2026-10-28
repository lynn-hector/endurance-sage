# 插件开发规范

> 状态：现行开发约定。宿主基线为 DSH `v0.2.1-rc.3`；升级宿主时同步核对本目录与官方文档。
>
> 读者：需要为 dsh-sentry 新增或修改 skill、系统提示词、tool、service、guard 的开发者。

本目录是插件开发的唯一入口，说明如何选择一个扩展点、实现插件、接入装配、验证契约并完成评审。系统为什么这样设计见 `docs/architecture/`；验证、发布和安装命令见[开发验证、发布与安装](../guides/development-release-install.md)。

## 1. 规范用语与来源

本目录使用三个标记区分约束来源：

- **DSH**：Cordis/DSH 提供的插件、`inject`、Config、tool、skill、system prompt 与 guard 机制。
- **Sentry**：本仓库额外要求的目录、命名、依赖方向、evidence、Session 路由、凭据和只读约束。
- **建议**：默认可读性与可维护性做法；有充分理由时可以偏离，但应在 PR 中说明。

文中的“必须”属于合并门槛，“建议”不是强制门槛。示例表达当前推荐写法；历史包存在命名或实现差异时，以新代码遵守本规范为准，不为了形式一致做无行为收益的全量改名。

## 2. 文档导航

| 我要… | 阅读 |
|---|---|
| 创建包、命名、声明导出和 Config、接入 bundle | [包结构与通用约定](package-conventions.md) |
| 增加方法论 skill、参考资料或常驻系统提示词 | [Skill 与系统提示词](skill-and-prompt.md) |
| 增加模型可调用的查询或操作能力 | [Tool 开发](tool.md) |
| 接入数据源、定义业务 seam、支持环境路由 | [Service 与 seam](service.md) |
| 拦截危险工具调用或增加审批策略 | [Guard 开发](guard.md) |
| 编写测试、更新文档、提交评审 | [测试与评审清单](testing-and-review.md) |

## 3. 先选择正确的扩展点

按能力的实际职责选择，不要因为“最终给模型使用”就把所有逻辑写进 tool。

| 新需求 | 默认扩展点 | 判断依据 |
|---|---|---|
| 教模型何时调查、按什么顺序交叉验证 | skill | 按需加载的方法论，不执行代码 |
| 每轮都必须遵守的角色、安全和表达原则 | system prompt | 常驻、短小、稳定，不是工具手册 |
| 让模型执行一个参数化查询或动作 | tool | 有明确参数、输出和错误语义 |
| 封装后端认证、传输、响应解析或本地资源 | service | 有真实资源或外部系统需要管理 |
| 让多个 tool 与多个后端实现解耦 | core Service Definition + service Provider | 接口需要跨实现替换或独立测试 |
| 在 tool 执行前拒绝或要求审批 | guard | 横切多个调用的策略，不属于某一查询 |
| 多个包共享纯解析、evidence 或配置词汇 | core package | 不包含具体 Provider 或 model-facing 注册 |

**不要为了“架构完整”给每个 service 都建立 Definition。** 只有一个真实后端且调用方不需要替换实现时，可使用命名 Cordis service；存在多个实现、明确替换需求或需要稳定消费契约时，再建立 `Definition ← Provider` seam。

## 4. 标准接入流程

### 4.1 只增加 skill 或修改系统提示词

1. 在现有 `sentry-skills` 或 `sentry-persona` 包中修改内容。
2. 增加或更新对应注册/内容测试。
3. 运行构建与测试，确认 Markdown 资源进入发布产物。
4. 更新关联 tool 文档或能力清单（如果行为描述发生变化）。

通常不需要新增 npm 包，也不需要修改 Provider Pool。

### 4.2 增加环境无关 tool / 共享 service

1. 在 `packages/tools/` 或 `packages/services/` 创建包。
2. 实现插件导出、Config、tool 或 service 契约。
3. 在 `renderEntries()` 中增加装配条目；共享 service 必须排在消费它的 tool 之前。
4. 为 tool 增加对应 skill，或更新已有 skill 的使用边界。
5. 增加包级测试、加载验证和发布验证。
6. 执行 `pnpm run sync:release`，让发布元数据与 bundle 依赖同步。

### 4.3 增加环境相关证据腿

除通用步骤外，还必须完成：

1. 在 `apps/agent/envs.yml` 声明各环境的 endpoint、数据源标识和 `*Ref`。
2. 在 `renderProviderEntries()` 中推导 Provider Config。
3. 在 `EnvProviderPool` 注册 Provider、业务腿和 Context 插槽。
4. 更新 `EnvProviderBundle`、`ISOLATED_SLOTS` 和必要的类型联合。
5. tool 通过 `ctx.envProviders.forCall(exec)` 获取 lease，不得直接注入具体 Provider。
6. 增加 Session 隔离、失败释放、按腿降级和证据环境身份测试。

完整细节见[Service 与 seam](service.md)。

### 4.4 增加 guard

1. 先证明策略确实属于横切门禁，而不是某个 tool 的参数校验。
2. 明确 allow / ask / deny，以及是否属于不可审批放行的 hard deny。
3. 实现 pre-execute 策略；绝对红线同时在 `ctx.tools.guard()` 终审。
4. 覆盖不相关工具直通、规则优先级、审批后终审和配置错误。
5. 在 `renderEntries()` 注册并更新 guard 架构文档。

## 5. 注册位置速查

| 位置 | 何时修改 |
|---|---|
| `packages/core/env-matrix/src/index.ts` 的 `renderEntries()` | 新增宿主级 tool、skill、persona、guard、共享 service |
| 同文件 `renderProviderEntries()` | 新增环境相关 Provider，或其 Config 推导变化 |
| `packages/services/env-provider/src/pool.ts` | 新 Provider 要进入按 Env 管理的资源池 |
| `apps/agent/envs.yml` | 新环境、新 endpoint、新凭据引用或数据源配置 |
| `packages/skills/sentry-skills/skills/` | 新增或调整模型方法论 |
| `packages/bundle/sentry/src/index.ts` | 通常不改；只有 bundle 自身装配语义变化才修改 |
| `scripts/sync-release.ts` | 通常不改；只有新的发布资源类型无法由现有规则处理才修改 |
| 根 `README.md` 与 `docs/index.md` | 新能力需要被发现，或文档入口变化 |

`pnpm run sync:release` 会同步包版本、发布元数据、bundle 依赖和生成物，但不会替开发者决定业务插槽、Provider 生命周期或 skill 内容。

## 6. 所有插件共享的底线

- **凭据**：装配和仓库只保存 `*Ref`；不得提交 token、密码、Cookie 或带认证信息的 URL。
- **只读**：证据 tool 默认只读。写操作必须单独评审权限、审批、幂等、审计和失败恢复。
- **环境隔离**：环境证据不得跨 Session、跨 Env 复用错误的 Provider 或伪造 env 标签。
- **证据诚实**：无数据不是零值，demo 不是真实证据，失败不能包装成成功。
- **资源生命周期**：请求有超时，lease 必须释放，长生命周期资源由 Cordis fiber 管理。
- **依赖方向**：`Tool → Definition ← Provider`；core 不依赖 tool 或具体 Provider。
- **生成物**：不手改由 `sync:release` 或 `regenerate` 生成的文件，修改权威源后重新生成。

## 7. 推荐参考实现

| 类型 | 参考 |
|---|---|
| Skill 包 | `packages/skills/sentry-skills/` |
| 系统提示词 | `packages/skills/sentry-persona/` |
| 环境相关 tool | `packages/tools/tool-metrics-inspector/` |
| 共享 service tool | `packages/tools/tool-tapd-inspector/` |
| Service Definition | `packages/core/metrics-store/` |
| Provider | `packages/services/prometheus/` |
| 共享命名 service | `packages/services/service-tapd/` |
| Guard | `packages/guard/git-guard/` |

阅读参考实现时同时阅读其 `tests/`，测试也是接口契约的一部分。

## 8. 相关文档

- [架构总览](../architecture/overview.md)
- [DSH 加载机制与官方文档入口](../architecture/dsh-loading.md)
- [Env / Session 路由](../architecture/session-env-routing.md)
- [git-guard 架构](../architecture/git-guard.md)
- [凭据管理](../guides/credentials.md)
- [开发验证、发布与安装](../guides/development-release-install.md)
