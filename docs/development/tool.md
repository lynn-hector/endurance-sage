# Tool 开发

> Tool 是 model-facing 接口：把清晰的调用意图转换为 service 请求，并返回可解释、可追溯的结果。

## 1. 职责边界

Tool 负责：

- 定义模型可见的名称、description、参数与输出。
- 校验业务参数组合和时间窗等调用约束。
- 通过稳定 seam 调用 service。
- 将结果转换为统一 evidence。
- 固定本次调用的环境与后端身份。
- 把后端失败转换为可诊断的错误证据。

Tool 不负责：

- 直接创建 HTTP 客户端或管理具体后端认证。
- 持有 endpoint、datasource UID、tokenRef 等 Provider 配置。
- 根据共享文件猜测“当前环境”。
- 把多个不相关数据源塞入一个无明确语义的大 tool。
- 用 guard 替代自身参数校验，或用参数校验替代执行层安全策略。

## 2. 基本结构

```text
packages/tools/tool-<domain>/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   └── ...               # 纯查询构造、结果整形等
└── tests/
    ├── <domain>.test.ts
    └── session-env.test.ts  # 环境证据 tool 必须按需覆盖
```

函数插件基本形态：

```ts
export const name = 'tool-example'
export const inject = ['tools', 'exampleService']
export const Config = z.object({})

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sentry_read_example',
    description: 'Read example records. Read-only.',
    parameters: {
      id: { type: 'string', required: true, description: 'Record id.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      // 调用 service，返回 buildEvidence(...) 或 buildEvidenceError(...)。
    },
  }))
}
```

示例中的 `exampleService` 表示已注册的共享命名 service。环境证据 tool 改为声明 `envProviders`，按本文第 6 节获取 lease。

## 3. 模型接口契约

### 名称

- 使用 `sentry_<verb>_<noun>`，如 `sentry_query_metrics`、`sentry_read_code`。
- 动词准确表达读、查、列、同步等行为，不滥用泛化的 `get` 掩盖副作用。
- 名称一旦发布即视为兼容接口；改名需要评估 prompt、skill 和调用方影响。

### Description

description 面向模型选择工具，至少包含：

- 能查询或执行什么。
- 是否只读。
- 关键模式或必要参数。
- 与相邻 tool 的选择差异。
- 会影响结果范围的重要默认行为。

实现细节、长篇教程和完整字段表放入 skill；但影响安全、数据范围或调用选择的约束不能只写在 skill 中。

### 参数

- 使用 JSON Schema 类型，必填字段显式 `required: true`。
- 数组就是数组，不使用逗号分隔字符串模拟数组。
- 使用 camelCase，保持同一包内命名一致。
- 为 limit、时间窗和返回大小设置合理边界，避免无界结果。
- 互斥或条件必填组合在 execute 中明确校验，并返回可操作错误。
- 被某个模式忽略的参数不得回显为实际执行条件。

普通环境证据 tool **不得新增 `env` 参数**。调用环境由 Session 绑定决定；需要切换环境时使用专门的 `sentry_env_switch` 流程。

## 4. Evidence 契约

所有证据 tool 使用 `@dsh-sentry/evidence`：

```ts
return buildEvidence({
  source: 'example-inspector',
  type: 'example',
  data: { records },
  summary: `查询到 ${records.length} 条记录`,
  confidence: 0.95,
  refs: ['env:example-env', 'example:record:1'],
})
```

失败使用 `buildEvidenceError()`，使成功与失败保持同一外壳。要求：

- `source` 使用稳定能力域名。
- 优先复用 `KNOWN_EVIDENCE_TYPES`；新的重复出现类型应提升为已知类型，而不是无限增加一次性字符串。
- `data` 是该 tool 的稳定 payload 契约，字段变更要考虑模型和 skill 的兼容性。
- `summary` 描述实际执行与结果，不包含未经验证的根因结论。
- `refs` 指向可定位证据，使用实际 env 和 `backendRef`，不得包含秘密。
- 完全失败时 `confidence = 0`；部分成功应低于完全成功并在 payload/summary 中明确失败项。
- 不用高 confidence 表示“系统健康”或“根因已确认”，它只描述本次证据的可靠程度。

必须区分：

1. 查询成功且数值为零。
2. 查询成功但没有匹配数据。
3. 查询失败。
4. 部分项目成功、部分项目失败。

空数组不能自动解释为“故障不存在”或“指标值为零”。

## 5. dryRun、demo 与错误

这些参数按能力需要提供，不是所有 tool 的形式化必选项。一旦提供，必须遵守统一语义：

- `dryRun` 只构造并返回后端中立请求，不发送实际操作。
- dry-run 不暴露具体 Provider 才拥有的认证、内部 URL 或连接细节。
- `demo` 明确标记演示数据，不得连接后端或冒充真实调查证据。
- 半配置宿主上的 demo 不得绕过“能力未配置”的事实检查。
- 参数错误、配置缺失、权限不足、超时和后端错误应可区分。
- 错误消息保留有用后端原因，但移除 token、Cookie、认证 header 和敏感连接串。
- 不用伪造空结果、固定记录或另一环境数据掩盖错误。

## 6. 环境相关 Tool

环境证据 tool 使用：

```ts
export const inject = ['tools', 'envProviders']

async execute(args, exec) {
  let call
  try {
    const lease = await ctx.envProviders.forCall(exec)
    call = lease
    const env = lease.env
    const store = lease.require('metricsStore')

    // 使用本次 lease 中固定的 env、store、backendRef。
    // 返回 buildEvidence(...)。
  } catch (error) {
    // 返回 buildEvidenceError(...)。
  } finally {
    await call?.release()
  }
}
```

实际实现应像现有工具一样，在路由成功后立即保存 `env`、`store`、`release` 的调用快照。关键约束：

- 在第一次后端 I/O 前固定 env、Provider 和 backend identity。
- 使用 `lease.require(slot)` 获得带具体腿原因的错误，不私自回退其他 Provider。
- 成功、参数失败、后端失败和异常路径都必须释放 lease。
- 调用开始后发生环境切换，本次调用仍使用旧 lease；下一次调用才使用新绑定。
- evidence 的 env 和 `backendRef` 必须来自实际 lease/Provider。
- 不在模块级缓存 lease、Session 或“当前 env”。

更完整的 Provider 注册和生命周期见[Service 与 seam](service.md)。

## 7. 共享 Service Tool

TAPD、代码仓库等环境无关能力可以直接注入命名 service：

```ts
export const inject = ['tools', 'tapd']
```

随后通过 `ctx.tapd` 调用。适用前提是平台级唯一资源，不需要按 Session 环境创建 Provider。共享 service 的 evidence 标签只用于来源定位，不能据此推断它参与了 Session 环境路由。

## 8. 安全与输出规模

- 新证据 tool 默认只读，使用最小权限凭据。
- 不在 tool 中拼接并执行模型提供的 shell、SQL 或脚本，除非该能力本身就是经过专项评审的查询接口。
- 查询接口应使用后端参数化能力或严格的语言/字段约束。
- 写操作必须单独评审审批、权限、幂等、审计、超时和恢复路径。
- 对列表、日志、评论和原始响应设置条数/字节上限，避免超大输出进入模型上下文。
- 不原样返回未筛选的后端大 payload；提取调查需要的字段并保留必要 refs。

## 9. 注册与配套 Skill

新 tool 包必须在 `renderEntries()` 增加唯一条目。若依赖共享 service，service 条目应先加载；若依赖环境 Provider，则完成 Provider Pool 全链路注册。

同时更新对应 skill：

- 何时选择和跳过该 tool。
- 参数与默认行为。
- 输出字段和空结果语义。
- 常见错误及下一步调查方式。
- 与其他证据的交叉验证链路。

## 10. 最小测试集

- 插件加载后 tool 名称确实注册。
- 参数类型、必填项和条件组合校验。
- 使用 fake Definition/共享 service 验证 tool 的消费契约。
- 成功、空结果、部分失败和完全失败的 evidence。
- dry-run/demo（如果提供）不访问真实后端。
- 环境 tool 的 Session 隔离、lease 固定与异常释放。
- 输出不包含秘密、Provider 私有配置或错误环境标签。
- 全仓依赖方向、类型检查、bundle 加载和发布包冒烟。
