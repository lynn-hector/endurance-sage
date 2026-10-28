# 测试与评审清单

> 目标：验证插件通过真实 seam 工作，而不只是实现内部函数可运行。本文最后一节可直接复制到 PR 描述。

## 1. 测试分层

### 1.1 纯逻辑测试

适合：

- 查询构造、时间解析、响应转换。
- evidence 字段整形。
- guard 规则匹配与优先级。
- 环境矩阵和装配 Config 推导。

要求输入输出明确，不依赖真实后端或全局 Session。

### 1.2 Seam 契约测试

Consumer 和 Provider 穿过同一个接口测试：

- Provider 加载后占用预期 Context 插槽。
- Consumer 可以使用 fake Definition，不需要具体 Provider。
- Provider 通过 Definition 返回稳定类型。
- transport 私有方法不被当作 Consumer 契约。
- 依赖方向测试持续通过。

不要只 mock tool 自己拥有的函数来证明 service seam 正确。

### 1.3 插件注册与 execute 测试

使用真实 Cordis Context、ToolRuntime 和必要最小桩启动插件：

- 验证 `inject` 和加载顺序。
- 验证 tool 名实际注册。
- 通过注册后的 tool 调用 execute，覆盖框架参数校验。
- 验证 system prompt section 或 filesystem skill 实际可发现。
- 测试结束释放 Context fiber。

测试桩只替代当前测试不关心的 seam；路由契约本身是被测对象时，应使用真实 binding/Pool 栈。

### 1.4 集成探针与真机验证

用于需要真实配置或宿主的行为：

- 外部数据源连通性和权限。
- Session 并发、切换、恢复和 Provider 生命周期。
- guard 的 GUI 审批路径。
- bundle 与声明式 loader 装配。

探针不替代可重复单元测试。真实凭据只从本机凭据平面读取，输出不得泄密。

### 1.5 发布验证

源码工作区加载成功不代表发布包完整。必须验证：

- 非 TS 资源进入 tarball。
- 所有运行时依赖声明正确。
- 独立目录只使用 tarball 可以安装并加载 bundle。
- 生成文件与权威源一致。

## 2. 按插件类型的最低测试矩阵

| 类型 | 必须覆盖 |
|---|---|
| Skill | 完整目录发现、frontmatter 移除、来源与资源路径、关键 tool/约束锚点、发布资源 |
| System prompt | section 注册、名称与内容锚点、最终 assemble 路径、资源打包 |
| Tool | 注册、参数、成功/空/失败 evidence、输出安全、service 消费契约 |
| 环境 Tool | Session 隔离、lease 环境固定、缺腿错误、所有路径 release、实际 backendRef |
| Definition | 请求/返回词汇、Context 类型、Consumer fake 契约、纯解析 |
| Provider | 插槽占用、configured/backendRef、认证、超时、后端错误、响应转换、资源清理 |
| Provider Pool | 按 Env 隔离与复用、配置换代、按腿降级、旧代际排空、统一 dispose |
| Guard | allow/ask/deny、hard deny 终审、直通、规则优先级、非法配置、已知绕过边界 |
| Bundle | 代码加载、声明式 loader、生成物一致、tarball 独立安装与加载 |

## 3. Skill 与文档测试原则

- 目录清单测试用于防止新 skill 未注册或意外丢失。
- 内容锚点只 pin 工具名、关键参数和稳定语义，不 pin 整篇措辞。
- 修改 tool 行为时必须同步运行对应 skill 内容测试。
- 新增文档链接应使用相对路径并检查目标存在。
- 文档示例必须与当前代码一致；发现示例本身有行为问题时先修正示例，不复制错误写法。

## 4. 常用命令

在仓库根目录执行。

聚焦测试：

```bash
pnpm vitest run packages/tools/tool-<domain>/tests
pnpm --filter @dsh-sentry/tool-<domain> run typecheck
```

完整开发验证：

```bash
pnpm run verify
```

`verify` 包含类型检查、单元测试、bundle 代码加载和声明式 Cordis loader 验证。

修改包集合、发布资源或环境矩阵后：

```bash
pnpm run sync:release
pnpm run verify
pnpm run release:pack
```

`release:pack` 执行构建、tarball 内容检查以及独立安装/加载冒烟。产物在 `output/`，不需要提交。

Session 路由专项验证：

```bash
pnpm --filter @dsh-sentry/dev run probe:session-env
```

git-guard 分层冒烟：

```bash
node_modules/.bin/tsx packages/guard/git-guard/src/smoke.ts
```

真实数据源探针按 `apps/dev/package.json` 提供的脚本执行。运行前先确认目标环境、只读权限和凭据，不在测试中打印秘密。

## 5. 提交前自查

### 5.1 变更范围

- 只修改权威源，生成物通过命令更新。
- diff 中没有无关格式化、个人配置、本机路径或真实凭据。
- 新包目录、包名、插件名、装配 ID、tool 名和插槽符合命名约定。
- 没有为了通过测试而删除必要断言或放宽依赖方向。

### 5.2 文档同步

按实际变化更新：

- `docs/development/`：开发契约或接入步骤变化。
- `docs/architecture/`：运行时设计、生命周期或所有关系变化。
- `docs/guides/`：操作、验证、部署或发布步骤变化。
- 根 `README.md`：用户可见能力全景变化。
- `docs/index.md`：新文档入口。
- 对应 SKILL.md：模型使用方式、参数或结果解释变化。

避免在多个文档复制同一份易变清单；指定一个权威来源，其他文档链接它。

## 6. PR 评审清单

以下清单可直接复制，按变更类型删除不适用项，但环境证据腿的 Session 与 lease 项不能删除。

### 设计与包契约

- [ ] 新能力选择了正确的 skill / prompt / tool / service / guard 扩展点。
- [ ] 包职责单一，core 不依赖具体 Provider 或 tool。
- [ ] 新 seam 有真实替换或测试价值，不是单纯转发层。
- [ ] `name`、`inject`、Config、默认导出和装配 ID 完整且一致。
- [ ] 运行时依赖、非 TS 资源和发布文件规则已声明。
- [ ] 未手工修改版本或生成物来绕过同步流程。

### Service 与 seam

- [ ] Tool 未实例化、默认导入或动态导入具体环境 Provider。
- [ ] endpoint、认证、datasource 和传输细节未泄漏到 tool Config/契约。
- [ ] Definition 的返回类型、空结果和错误语义明确。
- [ ] `backendRef` 指向实际后端且不含秘密，`configured` 语义真实。
- [ ] 请求有超时，认证缓存、连接、timer 和 fiber 有释放路径。
- [ ] 共享 service 与环境相关 Provider 的选择有明确依据。

### 环境与生命周期（环境证据能力必填）

- [ ] `envs.yml` 只包含配置和 `*Ref`，没有真实秘密。
- [ ] `renderProviderEntries()` 与 Provider Config 推导一致。
- [ ] `EnvProviderBundle`、`ISOLATED_SLOTS`、`PROVIDER_SERVICES` 等 Pool 注册完整。
- [ ] tool 使用 `forCall(exec)`，没有绕过 Session 的普通 `env` 参数。
- [ ] lease 在 `require()` 前保存，并在 `finally` 中释放。
- [ ] 调用开始后 env、Provider 和 `backendRef` 固定，不跨调用缓存 lease。
- [ ] 单腿失败按腿降级，不回退到另一 Env。
- [ ] 已覆盖并发 Session、异常释放和配置换代测试。

### Tool 与证据

- [ ] tool 名、description、参数和默认值准确反映行为。
- [ ] 新证据能力默认只读；写操作已完成专项安全评审。
- [ ] 使用统一 evidence builder，完全失败时 confidence 为 0。
- [ ] 零值、无数据、失败和部分成功可以区分。
- [ ] dry-run 不发送操作，demo 不冒充真实证据（如提供）。
- [ ] 输出有规模限制，不包含秘密或未经筛选的大 payload。
- [ ] 对应 skill 已同步工具选择、参数和结果解释。

### Skill、系统提示词与 Guard

- [ ] 常驻 prompt 只包含必须每轮生效的短规则，其余放入按需 skill。
- [ ] 新 skill 的目录名、frontmatter、目录清单测试和 references 完整。
- [ ] Guard 的 allow / ask / deny / hard deny 分级明确。
- [ ] 绝对红线经过 terminal guard，其他 listener 的 allow 无法放行。
- [ ] Guard 对不相关调用直通，非法配置 fail-loud。
- [ ] 字符串匹配未被描述为完整安全边界，已知局限已记录。

### 验证与文档

- [ ] 相关包测试、seam 测试和注册测试通过。
- [ ] `pnpm run verify` 通过。
- [ ] 涉及包/资源/装配变化时，`pnpm run release:pack` 通过。
- [ ] 需要真实环境的探针已执行，或明确记录未执行原因与风险。
- [ ] 架构、操作、能力清单和文档地图已按变化更新。
- [ ] diff 无秘密、无关改动、个人路径或临时调试代码。

## 7. 评审证据要求

PR 描述至少说明：

1. 新增能力及为什么属于该扩展点。
2. 修改了哪些注册点和生命周期。
3. 执行了哪些命令、探针和关键场景。
4. 哪些测试使用 fake，哪些使用真实实现或真实后端。
5. 兼容性、权限、安全和未验证风险。

“测试通过”应给出具体层级，不能只以类型检查或页面可启动代替行为验证。
