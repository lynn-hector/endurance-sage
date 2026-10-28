# Service 与 seam

> 本文是新增数据源和后端能力的主要规范。核心原则：调用方依赖稳定接口，Provider 隐藏传输、认证与资源生命周期；环境证据按 Session 租用 Provider。

## 1. 术语与职责

- **Definition**：`packages/core/` 中的后端中立接口、请求/返回词汇和 Context 插槽。
- **Provider**：`packages/services/` 中满足 Definition 或命名 service 契约的具体实现。
- **Seam**：调用方与 Provider 之间的可替换接口位置。
- **Consumer**：通过该接口使用能力的 tool 或其他 service。
- **Lease**：一次环境证据调用持有的 Provider 快照及释放句柄。

Definition 拥有稳定消费契约；Provider 拥有 endpoint、认证、连接、具体请求与响应解析。URL、UID、认证 header 和具体后端客户端不应无意穿越 seam。

## 2. 先选择 service 形态

### 2.1 命名 Cordis service

适用于：

- 只有一个真实后端。
- 调用方不需要替换实现。
- 接口本身就是该领域能力，不需要额外后端中立层。

例如 TAPD、代码仓库、Alertmanager 的当前实现。类继承 `Service`，通过 `super(ctx, '<slot>')` 注册。

### 2.2 Definition + Provider

适用于：

- 已有或明确将有多个后端实现。
- Consumer 需要与传输方式解耦。
- 需要在 seam 上独立测试 Consumer 和 Provider。
- 后端细节已经开始泄漏到多个调用方。

例如 `MetricsStore` 隐藏 direct Prometheus 与 Grafana proxy 的差异。

**一个实现不代表永远不能有 seam，但“假设未来可能替换”本身不是充分理由。** 新建 Definition 前写清哪个行为会跨接口变化、哪个测试会从这个 seam 获益。

### 2.3 环境相关与环境无关是独立决策

命名 service 与 Definition/Provider 都可能需要按 Env 管理。是否进入 Provider Pool 取决于资源是否随 Session 绑定环境变化，不取决于使用哪种接口形式。

- 随环境变化：进入 Provider Pool，由 tool 通过 `envProviders.forCall(exec)` 使用。
- 平台级共享：宿主级加载，由 tool 直接 `inject` 对应插槽。

## 3. Definition 契约

典型结构：

```text
packages/core/<capability>-store/
├── src/index.ts
├── tests/
└── package.json
```

示例骨架：

```ts
import { Context, Service } from '@deepseek-ai/cordis'

export interface ExampleQuery {
  id: string
}

export interface ExampleRecord {
  id: string
  summary: string
}

export abstract class ExampleStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'exampleStore')
  }

  abstract get backendRef(): string
  abstract get configured(): boolean
  abstract readExample(request: ExampleQuery): Promise<ExampleRecord>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleStore: ExampleStore
  }
}

export default ExampleStore
```

Definition 应包含：

- 小而完整的消费接口，而非 Provider 全部公共方法。
- 后端中立的请求与返回类型。
- `backendRef`：稳定、非秘密的实际后端身份，用于证据 refs。
- `configured`：配置是否足以服务查询，用于真实可用性判断。
- 方法的成功、空结果和抛错语义。
- Context 类型增强。

纯响应解析可放在 Definition 包，让所有 Provider 返回同一推理形状；具体 URL、认证和传输 helper 不属于这里。

## 4. Provider 契约

典型骨架：

```ts
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ExampleStore } from '@dsh-sentry/example-store'

export interface Config {
  endpoint?: string
  tokenRef?: string
  timeoutMs?: number
}

export class ExampleService extends ExampleStore {
  static Config: z<Config> = z.object({
    // 使用 datasource 的公共 Config 字段。
  })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    // 保存非秘密配置，创建受生命周期管理的资源。
  }

  override get backendRef(): string {
    // 只返回非秘密后端身份。
  }

  override get configured(): boolean {
    // 检查实际所需配置。
  }

  override async readExample(request: ExampleQuery): Promise<ExampleRecord> {
    // 解析凭据、执行带超时的请求、校验并转换响应。
  }
}

export default ExampleService
```

要求：

- Provider 默认导出插件类，供 Cordis loader 和 Provider Pool 加载。
- 不在 Consumer 中实例化 Provider；由装配或 Pool 创建。
- 仅将实现 Definition 所需的方法作为跨包消费契约。
- transport helper 可以保持公开用于本 Provider 测试/probe，但不能因此被 tool 当作跨 seam 接口。
- 后端非成功 envelope、HTTP 错误和响应形状错误必须显式处理。
- 返回后端中立类型，不把原始响应任意泄漏给 Consumer。
- `backendRef` 不得包含 token、密码、Cookie 或带秘密的 query。

## 5. 依赖方向

强制方向：

```text
Tool ─────────────→ Definition ←──────────── Provider
 │                                              │
 └──────── 共享命名 service（适用时）            │
                                                ↓
                                         外部系统 / 本地资源
```

禁止：

- tool 默认导入、命名空间导入或动态导入具体 Provider 插件。
- tool 导入具体 `*Service` Provider 类并自行实例化。
- tool Config 携带 endpoint、凭据、datasource 或仓库发现配置。
- core Definition 依赖具体 service 或 tool。

允许 tool 对共享命名 service 做类型导入，并通过 `inject` 使用其 Context 插槽；这与加载具体环境 Provider 插件不同。机械检查位于 `apps/agent/tests/dependency-direction.test.ts`。

## 6. 共享命名 Service 的接入

以 TAPD 形态为例：

1. 在 `packages/services/service-<domain>/` 实现 `Service`。
2. `super(ctx, '<slot>')` 注册插槽。
3. 声明实际需要的 `static inject`，例如 `credentials`。
4. 在 `renderEntries()` 中注册 service，再注册消费它的 tool。
5. tool 使用 `export const inject = ['tools', '<slot>']`。
6. 通过类型化 `ctx.<slot>` 调用，不创建第二个客户端。

共享 service 必须是真正的环境无关资源。如果 endpoint、认证或数据范围会随 Session 环境变化，就应进入 Provider Pool。

## 7. 环境相关 Provider 的完整接入

新增环境证据腿通常涉及以下所有位置。

### 7.1 环境矩阵

在 `apps/agent/envs.yml` 为每个支持环境声明：

- endpoint 或服务发现配置。
- datasource UID、数据库、项目等非秘密配置。
- `*Ref` 凭据引用名。

真实值保存在 `$DSH_HOME/.credentials.yaml` 或进程环境。不得为了本地联调把秘密写进矩阵。

如果新腿需要凭据 readiness，还要更新 `credentialReadiness()` 及对应测试，使缺失凭据只降级该腿，不阻断整个环境切换。

### 7.2 Config 推导

在 `renderProviderEntries()` 增加条目：

- `id` 在 Provider 配置集合中唯一。
- `name` 是 Provider npm 包名。
- `config` 只从当前矩阵行推导。
- 不在条目中读取或烘焙机器本地秘密。

Provider Pool 用这些推导结果计算配置版本。配置变化后，新调用使用新代际，旧调用排空后释放。

### 7.3 Provider Pool 注册

在 `packages/services/env-provider/src/pool.ts` 完成：

1. 导入 Provider 插件和必要类型。
2. 将 Consumer 可见实例加入 `EnvProviderBundle`。
3. 将插槽加入 `ISOLATED_SLOTS`，确保不同 Env 不共享同名注册。
4. 将 Provider 插件类型纳入 `ProviderPlugin` 联合。
5. 在 `PROVIDER_SERVICES` 注册 `packageName`、业务腿名、插件和插槽。
6. 如果一个 Provider 提供多个插槽，在同一个 `slots` 数组中完整声明。

遗漏任何一步都可能表现为“包已发布但 lease 中没有实例”、跨 Env 插槽冲突或配置无法换代。必须增加加载和隔离测试，而不是只靠类型检查。

### 7.4 Tool 消费

```ts
async execute(args, exec) {
  let lease: EnvProviderLease | undefined
  try {
    lease = await ctx.envProviders.forCall(exec)
    const env = lease.env
    const store = lease.require('exampleStore')
    const refs = [`env:${env}`, store.backendRef]

    const result = await store.readExample({ id: args.id })
    return buildEvidence({
      source: 'example-inspector',
      type: 'example',
      data: { env, result },
      summary: '查询成功',
      confidence: 0.95,
      refs,
    })
  } catch (error) {
    return buildEvidenceError({
      source: 'example-inspector',
      type: 'example',
      error: error instanceof Error ? error.message : String(error),
      summary: '查询失败',
      ...(lease ? { refs: [`env:${lease.env}`] } : {}),
    })
  } finally {
    await lease?.release()
  }
}
```

注意 `lease` 在 `require()` 之前保存，确保缺腿或后续任何失败都能释放。实际代码还需完成 `JsonValue` 等类型适配，保持与仓库现有 tool 一致。

### 7.5 调用与生命周期不变量

- `forCall(exec)` 从真实调用 Session 解析绑定，不能从全局变量或参数替代。
- 一个调用只使用一个 lease 中的 Env 和 Provider 代际。
- 同 Env 多 Session 可共享 Provider，不同 Env 的命名插槽必须隔离。
- 单腿创建失败进入 `unavailableLegs`，其他腿继续可用。
- 后端失败不自动切换到其他 Env。
- `release()` 幂等，但调用方仍必须在 `finally` 中执行。
- Provider 拥有的认证缓存和连接随对应 Cordis fiber 释放。

## 8. 凭据、超时与资源

使用 `@dsh-sentry/datasource` 的公共字段和解析函数：

- Config 中优先保存 `tokenRef`、`usernameRef`、`passwordRef` 等引用。
- 每次操作重新 `resolveCredential()`，不要跨凭据更新缓存秘密。
- session/Cookie 等派生认证状态可以缓存，但必须有明确 TTL、失效和清理策略。
- 所有外部请求有超时；重试次数和可重试错误必须明确。
- 401/403 是否重新登录取决于认证机制，不对所有错误盲目重试。
- timer 在成功和异常路径都清理。
- 长生命周期资源通过 `ctx.effect()` 或所属 fiber 释放。

## 9. 测试契约

Definition/Provider 至少覆盖：

- Provider 加载后实际占用预期 Context 插槽。
- `configured` 的完整、缺失和不同模式配置。
- `backendRef` 与实际后端一致且不含秘密。
- Consumer 通过 Definition 获得约定返回类型，而非 transport 原始响应。
- 后端非成功 envelope、HTTP 失败、无效响应与超时。
- 认证优先级、凭据更新、重试和资源释放（适用时）。

环境 Provider 还要覆盖：

- 两个 Session 使用不同 Env 时不串数据、不串 evidence。
- 同 Env 共享 Provider，配置换代后旧 lease 可完成并释放。
- 单腿失败不影响其他腿，`require()` 给出具体原因。
- lease 获取后的所有失败路径都释放。
- 工具不接受绕过 Session 的临时 Env。

## 10. 评审问题

- 这个 seam 是否有真实变化或测试价值，还是只增加转发层？
- Consumer 是否只需了解少量稳定请求/返回类型？
- 是否有 endpoint、认证或具体后端响应泄漏到 tool？
- 新 Provider 是否完成矩阵、渲染、Pool、隔离插槽和 tool 的全链路注册？
- 是否能在不启动真实后端的情况下测试 Consumer 和 Provider？
- 环境、后端身份、资源释放和错误语义是否有测试证明？
