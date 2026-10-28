# 包结构与通用约定

> 适用范围：所有 `packages/` 下的新插件与共享包。skill 内容、tool、service 和 guard 的专项契约见各自文档。

## 1. 一个包只承担一种主要角色

标准目录：

```text
packages/<group>/<package>/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # 插件或公共接口入口
│   └── ...               # 实现与运行时资源
└── tests/
    └── <contract>.test.ts
```

目录职责：

- `packages/core/`：Service Definition、evidence、共享配置词汇和纯领域逻辑。
- `packages/services/`：具体数据源 Provider、共享命名 service、Provider Pool。
- `packages/tools/`：注册 model-facing tool，不拥有具体后端传输细节。
- `packages/skills/`：方法论 skill 与系统提示词。
- `packages/guard/`：工具执行策略。
- `packages/bundle/`：版本化组合入口，不新增业务实现。

**Sentry：core 不得依赖 `service-*` 或 `tool-*`。** tool 不得通过默认、命名空间或动态导入加载具体 Provider 插件。现有 `apps/agent/tests/dependency-direction.test.ts` 是强制检查。

## 2. 命名契约

| 名字 | 规则 | 示例 |
|---|---|---|
| tool 包目录与包名 | `tool-<domain>` / `@dsh-sentry/tool-<domain>` | `tool-metrics-inspector` |
| 环境 Provider 包 | 优先 `<backend>` / `@dsh-sentry/service-<backend>` | `services/prometheus` → `service-prometheus` |
| 共享命名 service | `service-<domain>` / `@dsh-sentry/service-<domain>` | `service-tapd` |
| Definition 包 | `<capability>-store` / `@dsh-sentry/<capability>-store` | `metrics-store` |
| guard 包 | `guard-<domain>` / `@dsh-sentry/guard-<domain>` | `git-guard` → `guard-git` |
| model-facing tool | `sentry_<verb>_<noun>`，snake_case | `sentry_query_metrics` |
| skill 目录与 frontmatter 名 | kebab-case，两者完全一致 | `metrics-inspector` |
| Cordis Context 插槽 | camelCase，稳定且表达消费能力 | `metricsStore` |
| 装配条目 ID | `sentry-` 前缀，profile 内唯一 | `sentry-tool-metrics-inspector` |
| evidence `source` | 与能力域一致的 kebab-case | `metrics-inspector` |

目录名和 npm 包名不要求字面相同，但必须能从表中唯一推导。历史名称只在兼容需要时保留；新名称不得模仿临时探针或历史例外。

一个 tool 包可注册多个紧密相关的 tool；不要把互不相关的数据源能力合并成“大工具包”。

## 3. 函数插件契约

tool、skill provider、system prompt 和 guard 通常使用函数插件：

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'tool-example'

export const inject = ['tools']

export interface Config {
  // 只放本插件拥有的配置。
}

export const Config: z<Config> = z.object({})

export function apply(ctx: Context, config: Config): void {
  // 注册能力；需要清理的资源纳入 Cordis 生命周期。
}
```

要求：

- `name` 用于加载诊断，必须唯一、稳定。
- `inject` 只声明真正使用的 seam；不要为了“以后可能用”预声明。
- `Config` interface 与 schema 保持同步，必填项在 schema 中显式 `.required()`。
- 默认值由 schema 提供；直接构造的测试需要保留合理回退时，可使用与现有包一致的 `??` 收窄。
- 模块加载阶段不得执行网络请求或读取调用 Session；实际工作在插件生命周期或 tool 调用中发生。

Service 类插件的形态见[Service 与 seam](service.md)。

## 4. Config 归属

配置放在拥有该事实的包中：

- endpoint、datasource UID、连接 ID、超时、凭据引用属于 service。
- model-facing 行为开关、默认展示限制属于 tool。
- Session 默认环境属于绑定/装配层，不属于每个证据 tool。
- 普通环境证据 tool 不新增 `env` 参数，也不接收 endpoint 或凭据配置。
- 机器本地路径与秘密不得烘焙进生成装配。

凭据字段使用 `@dsh-sentry/datasource` 的公共词汇：

- `credentialRefField()`：声明凭据引用，优先用于组合文件。
- `secretField()`：确需支持内联秘密时标记为 secret；不得因此允许提交真实值。
- `resolveCredential()`：每次操作解析当前凭据，不跨凭据更新缓存秘密值。

## 5. package.json 与 TypeScript

新包至少声明：

- `"type": "module"`。
- `exports["."].types = "./dist/index.d.ts"`。
- `exports["."].default = "./dist/index.js"`。
- `typecheck` 与统一 `build` 脚本。
- 正确的运行时依赖和测试开发依赖。
- workspace 内依赖使用 `workspace:*`。
- DSH 依赖版本跟随仓库当前宿主基线，不自行升级单包。

`tsconfig.json` 通常继承根配置并包含源码和测试：

```json
{
  "extends": "../../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

版本、license、engines、repository、exports 和 files 由 `pnpm run sync:release` 统一校正。根 `package.json` 的 `version` 是唯一手工维护的版本号，不逐包修改。

## 6. 运行时资源

统一构建脚本会把 `src/` 下非 TypeScript 资源复制到 `dist/`。因此 persona Markdown 等包内资源应放在 `src/`，并使用相对当前模块的 URL 读取：

```ts
readFileSync(new URL('./persona.md', import.meta.url), 'utf8')
```

特殊资源：

- `sentry-skills/skills/` 整体作为发布资源，由发布同步脚本显式加入 `files`。
- `env-matrix/envs.yml` 和 bundle patch 也有专门发布规则。
- 新增不属于上述位置的包外资源时，必须同步调整构建/发布规则并增加 tarball 内容验证。

不得依赖“本地工作区恰好存在”的仓库相对路径读取运行时资源；发布安装后该路径可能不存在。

## 7. 注册与发布

新增包后按角色完成注册：

1. 宿主级插件加入 `renderEntries()`。
2. 环境相关 Provider 加入 `renderProviderEntries()` 和 Provider Pool。
3. 更新环境矩阵、skill、测试及能力文档。
4. 运行 `pnpm run sync:release`。
5. 检查生成物 diff，不手工调整生成结果。
6. 运行 `pnpm run verify` 和 `pnpm run release:pack`。

bundle 依赖由同步脚本从包清单生成，但**自动进入依赖不等于自动注册能力**。没有装配条目或 Provider Pool 配置的包不会提供运行时能力。

## 8. 生命周期与错误边界

- 插件加载失败应给出可定位的包名、配置项或规则，不静默降级为“已加载但无能力”。
- 环境 Provider 的单腿失败按 Provider Pool 契约降级，不阻断其他腿。
- timer、连接、Cookie 缓存和子进程必须有明确所有者与释放路径。
- 不在模块全局变量中保存 Session、Provider lease 或环境可变状态。
- 异步注册或资源初始化使用 Cordis 支持的插件生命周期，不让调用方观察到半初始化服务。

## 9. 反模式

- tool 直接实例化 `PrometheusService` 等具体 Provider。
- 为绕过 `inject` 而通过全局变量传递 Context 或 service。
- 把 endpoint、tokenRef 等 Provider Config 复制到 tool Config。
- 在 core 中导入具体后端解析器或 tool。
- 创建只有转发方法、没有真实替换需求的 Definition。
- 新增包后只运行 `sync:release`，遗漏装配或 Pool 注册。
- 手改版本、bundle 依赖或生成 patch 以“补齐”发布。
