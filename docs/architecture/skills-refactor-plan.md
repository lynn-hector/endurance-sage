# Sentry 插件 seam、Session/Env 解耦与 Skills 重构计划

> 状态：修订方案，待实施 · 2026-10-26
> 范围：`packages/core/`、`packages/services/`、`packages/tools/`、`packages/skills/`、`apps/` 及相关测试与文档
> 结构参照：`/Users/yangfm/workspace/work/endurance/plugins/sentry`
> 规范依据：DSH 的 Service Definition / Service Provider / Consumer 三角色 seam、Cordis 插件生命周期，以及 DSH 原生 skill 与 session 契约

## 1. 背景与本次修订

当前仓库已经按 `services/`、`tools/`、`skills/` 分包，但部分包只是按目录分类，尚未形成真正的能力 seam。例如 trace 的 Provider 直接继承 Cordis `Service`，Tool 直接依赖具体实现并持有 Grafana datasource 配置。与此同时，既有方案只处理 skill 文件加载，明确排除了 service、tool 与环境装配，无法解决以下整体问题：

- Provider 的数据源词汇泄漏到 Tool，切换后端需要同时修改 Tool、schema、证据和文档。
- 环境相关配置分散在 Tool 与 Service；热重载后，Tool 可能继续使用启动时冻结的配置。
- “不重启、不断会话”只被写成使用效果，没有说明 Session 与 Env 各自的生命周期、作用域和一致性约束。
- `sentry-skills` 仍手工维护清单、同步读取全部正文，没有使用 DSH 原生目录发现与按需加载。
- `tapd-inspector.md` 已存在但未进入手工清单；当前已注册 13 个 skill，完整领域集合应为 14 个。

本次将计划从“Skills 文件迁移”扩大为完整插件重整：先建立稳定的 Definition / Provider / Consumer 结构，再明确 Session/Env 解耦，最后迁移 Skills 骨架并逐个整理内容。

参考目录用于对照分包格式、接口职责、依赖方向和测试方式，不整目录覆盖当前实现。现有工具名称、参数行为、证据格式、环境矩阵和凭据约束必须逐项保留或显式记录差异。

## 2. 目标与非目标

### 2.1 目标

1. 按 DSH 官方 seam 规范拆分 Service Definition、Service Provider 与 Consumer。
2. 采用参考实现的 Service/Tool 包格式：Provider 持有后端配置和连接细节，Tool 只依赖抽象能力和 DSH `tools`。
3. 将 endpoint、凭据引用、datasource uid、后端路径、认证与重试等环境或 Provider 词汇移出 Tool。
4. 明确 Session 与 Env 是两条独立生命周期：切换 Env 不新建、不清空、不 fork Session。
5. 固定当前语义：Env 是 profile 级运行时配置，不是 Session 私有属性；所有打开的 Session 共享当前已生效环境。
6. 保留历史证据发生时的 `env` 与 `backendRef`，新调用按调用时环境生成证据，不回写历史。
7. 使用 DSH 原生 `<name>/SKILL.md` bundle 与 `@deepseek-ai/dsh-skill-filesystem`，恢复全部 14 个 skill。
8. 保持 `sentry_*` 工具名称与模型可见契约稳定，保持 persona、profile 和 preset 的装配方式可迁移、可验证。

### 2.2 非目标

- 不实现 Session 级环境，不允许同一会话通过查询参数自由选择 endpoint。
- 不承诺同一 profile 内多个 Session 可同时连接不同环境；有此需求时使用独立 profile 或宿主进程。
- 不修改 DSH Session 事件格式，不把当前 Env 写入 `SessionHeader`、`request/header` 或自定义 Session 镜像。
- 不把切换环境实现为新会话、会话 fork、历史压缩或清空上下文。
- 不替换现有日志、链路、指标、DB、MQ 等真实后端，只把后端差异收进 Provider。
- 不为只有一种固定领域实现的 TAPD、Zadig、代码仓库强行制造假想后端。
- 不在结构迁移阶段批量改写 skill 正文，不修改既有工具权限与生产安全策略。

## 3. DSH seam 的统一结构

### 3.1 三种角色

**Service Definition** 定义后端中立的能力词汇与 `ctx` 插槽，包含请求、结果、错误语义和不变式，不包含 endpoint、凭据、SQL、HTTP 路径或供应商配置。

**Service Provider** 继承 Definition，提供一种真实实现，拥有环境配置、认证、缓存、传输、解析、超时和资源释放。

**Consumer** 在本项目中主要是 Tool 插件，通过 `inject` 声明依赖，只调用 Definition；负责人机参数、工具描述、结果信封和模型可读错误，不创建 Provider，也不直接 import 具体 Provider。

```text
Service Definition（稳定意图）
  ↑                         ↑
Service Provider      Tool Consumer
（可替换实现）          （稳定模型入口）
        ↓                 ↓
  Env/凭据/连接        ctx.tools.register
```

依赖必须单向：Tool → Definition ← Provider。禁止 Tool → Provider，禁止 Definition → Provider/Tool。

### 3.2 Definition 格式

以 trace 为例，在 `packages/core/trace-store/` 定义抽象插槽：

```ts
import { Context, Service } from '@deepseek-ai/cordis'

export abstract class TraceStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'traceStore')
  }

  abstract get backendRef(): string
  abstract queryTrace(request: TraceQueryRequest): Promise<ParsedTrace>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    traceStore: TraceStore
  }
}

export default TraceStore
```

要求：

- 包只依赖 Cordis 及自身领域类型。
- `TraceQueryRequest` 不包含 `env`、endpoint、token、datasource uid 或 Grafana/Jaeger 专用字段。
- 文档写明只读性、空结果与基础设施错误的区别，以及 `backendRef` 的证据语义。
- 单实现插槽遵循 Cordis 的重复 Service 冲突规则，不另建一套注册表。

### 3.3 Provider 格式

以 `packages/services/trace/` 为例：

```ts
export class TraceService extends TraceStore {
  static Config = z.object({
    endpoint: z.string(),
    tokenRef: z.string(),
    // 其余均为该 Provider 的环境或后端配置
  })

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // 保存配置，并通过 ctx.effect() 释放缓存、timer 等资源
  }

  override get backendRef(): string { /* ... */ }
  override async queryTrace(request: TraceQueryRequest) { /* ... */ }
}

export default TraceService
```

要求：

- 包依赖 Definition 与共享的 `datasource`，不依赖 `dsh-tools`。
- endpoint、credential ref、datasource uid、后端模式、认证会话、重试和响应解析均留在 Provider。
- 凭据值在需要时解析，不写入日志、证据或 Session；Provider 销毁时清理认证 cookie、连接与 timer。
- `backendRef` 标识当前实际后端，供 Tool 生成证据；不让 Tool 自己拼接 Provider 内部标识。

### 3.4 Tool 格式

Tool 与参考实现保持同样的薄 Consumer 结构：

```ts
import type {} from '@dsh-sentry/trace-store'

export const name = 'tool-trace-analyzer'
export const inject = ['tools', 'traceStore']

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sentry_fetch_trace',
    // 保持既有 parameters/output 契约
    async execute(args) {
      const parsed = await ctx.traceStore.queryTrace({
        traceId: args.traceId,
        start: args.start,
        end: args.end,
      })
      return buildEvidence({
        // data、summary、confidence 按既有规范
        refs: [ctx.traceStore.backendRef, `env:${activeEnv()}:traces`],
      })
    },
  }))
}
```

要求：

- 依赖 `@deepseek-ai/dsh-tools`、Definition、`evidence`，以及必要的环境标签读取能力。
- 只以类型方式引入 Definition 的 Context 增强，运行时不 import Provider。
- `inject` 使用能力插槽名，如 `traceStore`、`logStore`，不再使用具体实现名 `trace`、`greptimedb`。
- Tool 不持有 Provider 配置；确属调用者意图的逻辑选择（例如 SQL 查询的 `database`）可保留，并说明为何不是 Provider 词汇。
- 普通证据 Tool 不增加 `env` 查询参数。环境切换只通过 `sentry_env_*` 完成。

### 3.5 固定领域 Service 的处理

代码仓库、TAPD、Zadig 在参考结构中是具名 Cordis Service，分别占用 `ctx.codeRepository`、`ctx.tapd`、`ctx.zadig`。它们仍须遵守 Provider/Consumer 隔离，但本次不额外创建没有实际替换需求的抽象包。

这不构成例外通道：Tool 依然只依赖具名领域接口，不能直接调用 HTTP 客户端或读取 endpoint；未来出现第二种真实实现时，再把稳定词汇抽为 Definition。

## 4. 目标包结构与职责映射

```text
packages/
├── core/
│   ├── log-store/          # Definition: ctx.logStore
│   ├── trace-store/        # Definition: ctx.traceStore
│   ├── metrics-store/      # Definition: ctx.metricsStore
│   ├── db-store/           # Definition: ctx.dbStore
│   ├── cache-store/        # Definition: ctx.cacheStore
│   ├── mq-store/           # Definition: ctx.mqStore
│   ├── datasource/         # endpoint/credential/timeout 的共享配置辅助
│   ├── env-matrix/         # 环境矩阵、装配渲染、desired/active Env 观测；不持有 Session
│   └── evidence/           # 统一证据信封
├── services/
│   ├── greptimedb/         # LogStore Provider
│   ├── trace/              # TraceStore Provider
│   ├── prometheus/         # MetricsStore Provider
│   ├── dbx/                # DbStore + CacheStore 两个 Provider，共享一个客户端
│   ├── rocketmq/           # MqStore Provider
│   ├── code-repository/    # 具名领域 Service，需补全当前占位实现
│   ├── service-tapd/       # 具名领域 Service
│   └── zadig/              # 具名领域 Service
├── tools/
│   ├── tool-log-analyzer/
│   ├── tool-trace-analyzer/
│   ├── tool-metrics-inspector/
│   ├── tool-db-inspector/
│   ├── tool-redis-inspector/
│   ├── tool-mq-inspector/
│   ├── tool-code-repository/
│   ├── tool-tapd-inspector/
│   ├── tool-zadig-inspector/
│   └── tool-env-switcher/
└── skills/
    ├── sentry-skills/
    └── sentry-persona/
```

| Definition / 具名插槽 | 当前 Provider | Tool Consumer | 必须收进 Provider 的内容 |
|---|---|---|---|
| `ctx.logStore` | GreptimeDB | `tool-log-analyzer` | SQL、表名、endpoint、认证、字段白名单 |
| `ctx.traceStore` | Grafana-Jaeger / Jaeger | `tool-trace-analyzer` | datasource uid、查询路径、登录 cookie、后端模式 |
| `ctx.metricsStore` | Prometheus | `tool-metrics-inspector` | datasource、PromQL 执行细节、认证 |
| `ctx.dbStore` | dbx | `tool-db-inspector` | dbx 连接发现、平台请求、认证刷新 |
| `ctx.cacheStore` | dbx | `tool-redis-inspector` | Redis 平台协议、连接发现、值解码 |
| `ctx.mqStore` | RocketMQ | `tool-mq-inspector` | 管理接口、集群连接与认证 |
| `ctx.codeRepository` | 本地代码仓库 | `tool-code-repository` | baseDir、仓库发现、受控子进程 |
| `ctx.tapd` | TAPD | `tool-tapd-inspector` | workspace、OpenAPI、token |
| `ctx.zadig` | Zadig | `tool-zadig-inspector` | project/envName、OpenAPI、token |

dbx 是一个平台客户端同时提供两个 seam，不应为了“一 Service 对应一插槽”的形式整齐而复制登录与连接缓存。`tool-env-switcher` 只注入 `tools`，通过 `env-matrix` 操作装配，不注入任一证据 Provider。

## 5. Session 与 Env 解耦

### 5.1 两个概念及第三种“会话”

| 概念 | 所有者与生命周期 | 保存什么 | 切换环境时 |
|---|---|---|---|
| DSH Session | DSH 会话存储；由创建、恢复、fork、压缩等会话机制管理 | 用户/助手消息、工具调用与结果、请求记录等历史事实 | 不新建、不清空、不 fork，历史保持原样 |
| Sentry Env | 环境矩阵与当前 profile 装配；由切换器写入、watcher 应用 | 当前环境的 Provider 配置、endpoint、credential ref、环境标签 | 重建相关 Provider，新调用使用新配置 |
| 后端认证 session | 单个 Provider 实例内部 | Grafana/dbx cookie、过期时间等 | 随旧 Provider 释放，不进入 DSH Session |

Grafana/dbx 的登录 session 与 DSH Session 完全不同，文档和代码命名不得混用。前者是 Provider 私有认证缓存，后者是用户对话历史。

### 5.2 作用域决定

当前设计选择 **profile 级共享 Env**，而不是 Session 级 Env：

- 一个 profile 的当前装配决定该宿主中所有证据 Provider 的连接目标。
- 已打开的多个 Session 共享这次切换；切换后，它们的新查询都面向当前已生效环境。
- Session 恢复、fork 或压缩不会恢复、复制或切换 Env。
- 普通 Tool 不接受 `env` 参数，防止单次调用绕过统一装配与凭据校验。
- 需要并行排查不同环境且互不干扰时，使用不同 profile 或宿主，不在本方案中增加 Session 路由层。

这是必须写入用户文档的操作语义，不能只写“当前会话无需重启”而让读者误以为环境是 Session 私有状态。

### 5.3 切换时序

```text
用户在已有 Session 中请求切换
  → sentry_env_switch 只接受 envs.yml 中的名称或别名
  → 校验目标环境的 credential refs
  → 原子更新生成的 profile 装配
  → DSH watcher 应用配置并重建相关 Provider
  → 原 Session ID、历史消息与已有工具结果保持不变
  → 后续 Tool 调用经过原 Definition，到达当前 Provider
  → 新证据记录调用时的 env 与 backendRef
```

`env` 是证据快照，不是路由指令。切换前的历史证据仍属于旧环境，切换后的回答必须区分历史证据与新查询结果，不能把两者无标注地拼成同一环境结论。

运行时还要区分两个状态，它们都属于宿主而不是 Session：

- **目标环境（desired Env）**：生成装配声明、希望 watcher 应用的环境，用于切换进度与 pending 判断。
- **生效环境（active Env）**：实际 Provider 已加载并用于本次查询的环境，只能由运行时激活状态与实际后端身份确认。

证据中的 `env` 必须表示 active Env，不能直接用 desired Env 代替。`env-matrix` 可以维护装配与运行时观测，但不得把这两个状态折叠成一个文件标签，也不得将它们复制到 Session。

切换工具返回“文件已写入”不等于“所有 Provider 已生效”。必须继续通过 `sentry_env_current`、运行时状态和一次目标环境查询确认；热重载 pending 或失败时不得把文件中的目标环境直接声称为已连接环境。

### 5.4 配置与状态禁止项

- 不把 endpoint、token、credential ref、datasource uid 写入 Session 事件或 skill 正文。
- 不在 Session 中维护 `currentEnv`，不订阅 Session 事件来重建环境镜像。
- 不从历史最后一条 evidence 反推当前环境；当前环境只来自运行时事实。
- 不让 Tool 在启动时固化环境标签或 Provider 配置。
- 不让旧 Provider 的认证缓存、timer、请求重试跨越释放后的生命周期。
- 不用“为了切换环境而新建 Session”掩盖 Provider 重载失败。

### 5.5 调用一致性

Env 标签和 `backendRef` 必须在同一次 Tool 调用中基于当前运行时生成。若装配已切换而 Provider 尚未完成切换，结果必须显式呈现 pending/不一致或失败，不能只更换证据标签后继续返回旧后端数据。

切换过程中已经在执行的调用按一次调用处理：返回其真实结果或明确错误，不把一次调用的请求与响应标成两个环境。只读查询是否重试必须遵循现有超时与重试策略；环境切换后不得在未重新确认环境的情况下盲目重试并拼接结果。

## 6. 分阶段实施：Service 与 Tool

### 6.1 阶段 A：建立 Definition 与契约测试

先增加六个 Store Definition，不切换生产调用：

1. 从现有 Tool/Service 的公共调用中提取后端中立请求与结果。
2. 为每个 Definition 写最小 fake Provider，通过公开 `ctx` 插槽测试，而不是测试私有 helper。
3. 固定空结果、错误、只读性、backendRef 和资源释放语义。
4. 删除请求中的 endpoint、datasource uid、token 等 Provider 字段，把它们迁回 Provider Config。

每个 Definition 一个独立提交，顺序建议：`trace-store` → `log-store` → `metrics-store` → `db-store`/`cache-store` → `mq-store`。

### 6.2 阶段 B：按证据腿迁移 Provider 与 Tool

每次只迁移一条证据腿，保持该腿工具名和 schema 可对比：

- [ ] trace：Provider 继承 `TraceStore`；Tool 改为 `inject = ['tools', 'traceStore']`；移除 Tool 的 Jaeger/Grafana 配置。
- [ ] logs：抽出 `LogStore`；GreptimeDB SQL 与字段约束归 Provider；保留现有过滤 DSL 行为。
- [ ] metrics：抽出 `MetricsStore`；Tool 只组织指标发现、查询与证据。
- [ ] db/redis：dbx 共享客户端，分别提供 `DbStore`、`CacheStore`；共同生命周期一并释放。
- [ ] mq：RocketMQ 提供 `MqStore`；消息列表与消费轨迹沿用 Definition 词汇。
- [ ] code repository：补全当前占位 Service，再让 Tool 通过 `ctx.codeRepository` 调用；固定 argv 与 ff-only 约束仍在 Service。
- [ ] TAPD/Zadig：保持具名领域 Service，移除 Tool 中残留传输细节，不新增假想 Store。

每条腿都先加“fake Definition 可替换真实 Provider”的 Tool 测试，再改实现。禁止以复制参考目录代替这些契约测试。

### 6.3 阶段 C：收拢环境配置

1. `apps/agent/envs.yml` 继续作为环境矩阵唯一手工维护点。
2. Provider 的环境字段由 `env-matrix` 渲染到对应 service entry；Tool entry 只保留真正的 Consumer 配置。
3. `datasourceUid`、endpoint、credential refs 等不得再渲染进 Tool Config。
4. 区分 desired Env 与 active Env：装配文件用于前者和 pending 判断，Provider 激活观测用于后者；Tool 证据使用本次实际 Provider 的 active Env 与 `backendRef`，不得继续把 `liveEnvOr()` 读到的文件标签直接当作已生效环境。
5. 保留 `sentry_env_list/current/switch` 与 dry-run、别名、凭据就绪门；`current` 同时报告目标、生效与 pending 状态，不增加任意路径或 endpoint 注入。
6. 更新 profile、dev probe 和 shell/entries 两种装配形态的依赖声明，确保 Provider 先于 Consumer 可用，缺失时能明确报错。

### 6.4 阶段 D：验证 Session/Env 解耦

在真实 DSH 宿主完成，而不只测试 YAML：

1. 创建两个 Session，分别产生带旧 Env 的历史证据。
2. 在其中一个 Session 切换到目标 Env，记录 Session ID、事件数及关键历史前缀。
3. 确认两个 Session 都仍存在、ID 不变、旧证据未被修改，且没有发生自动 fork/compact/new。
4. 等 Provider 重载完成后，从两个 Session 分别发起新查询；二者都应使用目标 Env，证明不是 Session 私有切换。
5. 恢复或 fork 一个历史 Session，确认它读取当前 Env，而不是恢复历史 Env。
6. 验证释放后的旧 Provider 不再响应、不保留认证缓存或活动 timer。
7. 模拟 watcher pending/失败，确认系统不会只更新标签却把旧环境结果冒充为新环境结果。

## 7. 分阶段实施：Skills 原生骨架

Service/Tool 与 Session/Env 契约稳定后，再迁移 14 个 skill。骨架迁移不保留手工注册与文件系统注册并存的过渡期。

### 7.1 目标结构

```text
packages/skills/sentry-skills/
├── src/index.ts                  # 只挂载包内 native skill provider
├── skills/
│   ├── code-repository/SKILL.md
│   ├── cross-service-latency/SKILL.md
│   ├── db-inspector/SKILL.md
│   ├── defect-troubleshooting/SKILL.md
│   ├── env-switcher/SKILL.md
│   ├── incident-templates/SKILL.md
│   ├── log-analyzer/SKILL.md
│   ├── metrics-inspector/SKILL.md
│   ├── mq-inspector/SKILL.md
│   ├── project-context/SKILL.md
│   ├── redis-inspector/SKILL.md
│   ├── tapd-inspector/SKILL.md
│   ├── trace-analyzer/SKILL.md
│   └── zadig-inspector/SKILL.md
└── tests/sentry-skills.test.ts
```

文件系统 provider 只发现扫描根目录的直接子项 `<root>/<name>/SKILL.md` 或 `<root>/<name>.md`。统一使用目录 bundle，不增加业务分类嵌套；`references/` 仅在确有长篇、低频资源时创建。

### 7.2 机械迁移

- `src/skills/<name>.md` 移至 `skills/<name>/SKILL.md`，本阶段不改正文。
- 将当前 TypeScript 清单中的 `name`、`description` 机械搬入 YAML frontmatter；`name` 与目录名一致。
- `tapd-inspector` 保留并核对已有 frontmatter，纳入完整目录测试。
- 不新增 `whenToUse`、`disable-model-invocation` 或 `user-invocable`，保持默认模型与用户均可调用。
- 删除 `SkillSpec`、`SKILLS` 与 `loadSkillContent()`，元数据只保留 frontmatter 一个来源。

入口改为薄适配器：

```ts
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import * as FileSystemSkills from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'sentry-skills'
export const inject = ['skills']

export function apply(ctx: Context): void {
  ctx.plugin(FileSystemSkills, {
    providerName: 'sentry-bundled',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
    watch: true,
  })
}
```

增加 `@deepseek-ai/dsh-skill-filesystem`，版本跟随当前 DSH 依赖线并更新 lockfile。保留包名、exports 与 profile/preset 装配入口；`includeDefaultRoots: false` 避免重复扫描宿主目录，唯一 `providerName` 避免冲突，context 销毁时 watcher 一并释放。

## 8. Skills 内容规范与顺序

### 8.1 内容职责

`SKILL.md` 主文件保留使用时机、必要输入、工作流程、工具选择、安全与证据纪律，以及必要示例和引用。完整模板、大型附录、复杂 DSL 和低频资料才拆入 `references/`，并验证模型能沿 bundle 相对链接读取。

工具参数与返回 schema 以 Tool 注册为事实源；Skill 不复制完整 schema，也不复制 endpoint、环境装配或 Provider 细节。Skill 只解释何时选 Tool、如何控制查询成本、如何组合证据及如何解释错误。

`env-switcher` 必须明确：Env 是 profile 级共享运行时配置；切换保留 Session，但影响该 profile 中所有 Session 的后续查询；历史 evidence 不会改写；不是 Session 级路由，也不是线上配置变更。

Persona 只保留全局行为、安全纪律和技能路由。`defect-troubleshooting` 是主流程与路由入口，不成为第二个常驻 persona。

### 8.2 实施顺序

- [ ] 1. `log-analyzer`：作为内容样板，确定主文件、DSL、示例与检查清单的拆分尺度。
- [ ] 2. `trace-analyzer`：收敛 traceId 输入、慢/错调用分析，Provider 细节不进入正文。
- [ ] 3. `metrics-inspector`：区分指标发现、PromQL、告警与异常拐点。
- [ ] 4. `db-inspector`：保留只读约束，突出慢 SQL 与连接证据。
- [ ] 5. `redis-inspector`：收敛 key 类型、TTL、解码与缓存证据。
- [ ] 6. `mq-inspector`：明确消息列表、消费轨迹、积压与丢失路径。
- [ ] 7. `zadig-inspector`：突出部署时间线、镜像版本与故障窗口。
- [ ] 8. `tapd-inspector`：完善现象与已知缺陷对账及人工证据边界。
- [ ] 9. `code-repository`：区分搜索、读取、ff-only 同步与会话工作区。
- [ ] 10. `env-switcher`：完整写入第 5 节作用域与历史证据语义。
- [ ] 11. `defect-troubleshooting`：收敛为主流程与路由，附录按需拆分。
- [ ] 12. `cross-service-latency`：复用主流程和证据技能，不复制工具说明。
- [ ] 13. `incident-templates`：保留模板选择规则，完整模板按加载成本拆分。
- [ ] 14. `project-context`：区分稳定架构知识与易过期环境信息。
- [ ] 15. `sentry-persona`：最后去重，只保留全局行为、安全纪律和技能路由。

每个 skill 均检查 frontmatter、工具名称、旧 Python CLI 与旧 `--env` 清理、交叉引用、资源链接和关键内容测试；每次只处理一个 skill。

## 9. 测试与验收

### 9.1 Definition / Provider / Tool

- **Definition 契约**：fake Provider 能占用对应插槽；请求无 Provider 配置；错误、空结果与只读语义稳定。
- **Provider 测试**：覆盖配置校验、传输与解析、认证刷新、超时、backendRef、资源释放；dbx 同时覆盖两个插槽和共享生命周期。
- **Tool 测试**：用 fake Definition 验证 schema、参数映射和证据信封；不需要启动真实后端。
- **依赖方向**：自动检查 Tool 不 import Provider，普通 Tool Config 不含 endpoint/tokenRef/datasource uid 等字段。
- **回归**：保留现有 SQL、安全、错误文案、证据格式和工具名称测试，差异必须显式记录。

### 9.2 Session/Env 专项

- 切换前后 Session ID、历史前缀与既有 evidence 不变。
- 两个已打开 Session 的后续调用都使用新 Env，验证 profile 级作用域。
- Session 恢复、fork、compact 均不选择或恢复 Env。
- 新调用证据中的 Env 与 backendRef 对应同一次实际查询。
- Provider 重建后无旧认证缓存、连接、timer 泄漏。
- watcher pending/失败、切换中调用、缺失凭据和未知别名均有明确行为。
- 禁止出现 `session.currentEnv` 之类镜像，以及从 Session 历史解析当前 Env 的实现。

### 9.3 Skills 骨架与内容

1. 精确断言 14 个名称，包含 `tapd-inspector`。
2. 每个名称均可通过 `ctx.skills.get(name)` 取得不含 frontmatter 的非空正文。
3. `source` 为 `bundled`，`provider` 为 `sentry-bundled`，`resourceBase` 指向当前 bundle。
4. preset A 挂载后 A 可见，未挂载的 B 不可见；context 销毁无 watcher 悬挂。
5. frontmatter 或资源变化可刷新；资源链接经真实 DSH 加载验证。
6. 保留无 Python CLI、无旧 `--env`、log SQL 顺序等内容回归测试。
7. `env-switcher` 与 persona 不再出现“Session 级切换”或“切环境只影响当前会话”的误导表述。

### 9.4 验证命令

各结构阶段至少运行：

```bash
pnpm typecheck
pnpm test
pnpm dev
pnpm dev:loader
```

完成全部迁移后运行：

```bash
pnpm verify
```

真实 DSH 验收还须覆盖第 6.4 节的双 Session 场景，以及 skill catalog、原生加载、preset 隔离和资源读取。仅通过单元测试或 YAML snapshot 不能判定完成。

## 10. 文档同步

结构迁移与对应阶段同步更新，不留互相矛盾的说明：

- `docs/index.md`：将本计划入口改为完整插件架构重整。
- `docs/guides/env-switching.md`：补充 profile 级作用域、多 Session 影响、历史证据语义与 pending 状态；统一“模型可调用切换工具”和“人工运维切换”的表述。
- `docs/guides/onboarding.md`、`docs/guides/runbook.md`：说明 Session 工作区、代码证据根目录、Sentry Env 三者互不推导。
- `packages/skills/sentry-skills/skills/env-switcher/SKILL.md`：作为模型侧环境操作事实源。
- 相关包 README：按 Definition / Provider / Consumer 标注角色，不再把具体 Service 名称当作通用 seam 名称。

## 11. 风险与回退

- 按证据腿小步迁移，每一步可独立回退；不一次性复制参考仓库全部文件。
- Definition 一旦确定先保持兼容，避免 Provider 与 Tool 长期双写；确需过渡时必须有明确删除点和完整目录测试。
- Provider 配置迁出 Tool 会改变热重载行为，必须以双 Session 与真实后端查询验证，不能仅看类型检查。
- Env 是共享状态，文档与 UX 必须提示切换影响其他打开的 Session，避免并行排查互相串环境。
- 文件环境、已加载环境和证据环境可能短暂不同，禁止用单一文件标签掩盖不一致。
- 原生 skill provider 会跳过无效 frontmatter，14 项完整目录断言是必要门禁。
- 骨架迁移与正文改写分开，资源拆分必须保留主文件导航并验证真实读取。

## 12. 完成定义

同时满足以下条件才认为重构完成：

- 六个 Store seam 均按 Definition / Provider / Consumer 拆分；代码仓库、TAPD、Zadig 的具名 Service 也实现 Consumer 隔离。
- Tool 不 import 具体 Provider，不持有 Provider 环境配置；Provider 后端可替换而 Tool 与模型契约无需改变。
- dbx 的两个插槽共享同一受管客户端，所有 Provider 的资源释放经测试。
- Session 与 Env 生命周期解耦并有双 Session 实证：切换保留历史、影响后续共享查询，不引入 Session 级 Env。
- 历史证据保持查询时环境，新证据真实对应当前 Provider；pending/失败不会被错误标记为切换成功。
- 环境矩阵、凭据校验、工具名称、schema、安全策略及 profile/preset 装配保持兼容或具有显式迁移记录。
- 14 个 skill 全部使用原生目录 bundle 与 frontmatter，无手工元数据清单，`tapd-inspector` 遗漏已修复。
- Skills、persona 与环境指南准确描述 Session/Env 解耦，不再有 Session 级切换的误导。
- 类型检查、单元测试、程序化和声明式探针、真实 DSH 双 Session 与 skill 验收全部通过。
