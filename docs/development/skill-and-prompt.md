# Skill 与系统提示词

> 目标：让模型在正确时机获得适量、可执行、与真实 tool 一致的指令。

## 1. 二者的分工

**Skill** 是按需加载的方法论：

- 某类故障的调查步骤。
- 一组相关 tool 的使用边界与参数说明。
- 结果解释、交叉验证和常见误区。
- 较长的领域背景与参考资料。

**系统提示词**是每轮常驻的行为原则：

- 故障调查员角色与证据优先原则。
- 安全、凭据和只读边界。
- 稳定的沟通与结论表达要求。
- 少量必须始终生效的规则。

不要把完整 tool 手册、环境清单或长篇案例放进系统提示词；这些内容应进入 skill 或 references。相反，必须每轮生效的安全原则不能只存在于某个可能不加载的 skill。

## 2. Skill 包结构

现有方法论统一放在：

```text
packages/skills/sentry-skills/
├── src/index.ts
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md
│       └── references/       # 可选：案例、格式、较长参考材料
│           └── <topic>.md
└── tests/sentry-skills.test.ts
```

`sentry-skills` 使用 DSH filesystem provider 发现 `skills/<name>/SKILL.md`：

- `includeDefaultRoots: false`，只发现本包内容。
- `providerName: 'sentry-bundled'`，标识来源并避免注册冲突。
- `watch: true`，支持内容热更新。
- frontmatter 是元数据权威来源，不维护第二份手工 manifest。

新增一个领域 skill 通常只需要新增目录和测试，不需要创建新的 npm 包。

## 3. SKILL.md 契约

最小格式：

```markdown
---
name: example-inspector
description: 何时使用本能力、解决什么问题，以及主要 tool 的边界。
---

# example-inspector

## 使用边界

## 工具与参数

## 输出与证据语义

## 推荐链路

## 检查清单
```

要求：

- `name` 与目录名完全一致，使用 kebab-case，在包内唯一。
- `description` 同时说明适用任务和主要能力，帮助模型选择 skill。
- 正文移除 frontmatter 后仍应自包含，但不重复无关项目背景。
- tool 名、参数名、默认值和限制必须与实现一致。
- 写明跳过场景，避免每个任务都机械调用整组 tool。
- 写明空结果、错误、demo、部分失败等解释规则。
- 多证据场景写明交叉验证原则，不把相关性直接表述为因果。
- 普通环境证据 tool 不文档化 `--env` 或虚构的 `env` 参数；环境来自 Session 绑定。
- 示例使用当前 DSH tool，不保留已迁移的 Python CLI 调用。

## 4. references 使用规则

把不必随 skill 主体一起阅读的内容放到 `references/`：

- 大量查询示例。
- 故障案例和输出样例。
- 后端字段表或模板。
- 长篇领域背景。

主体应说明何时读取哪份参考，而不是只堆放文件。参考资料同样属于发布产物，必须：

- 使用相对、可定位的链接或路径。
- 不包含真实凭据、内部秘密或不可公开的客户数据。
- 与 tool 当前行为一致。
- 在发布包冒烟中确认可被访问。

## 5. 新增或修改 Skill 的步骤

1. 新建 `skills/<name>/SKILL.md`，或修改已有 skill。
2. 如果新增 skill，把它加入 `sentry-skills.test.ts` 的 `SKILL_NAMES`，并同步目录数量描述。
3. 增加内容锚点测试，至少覆盖关键 tool 名和容易漂移的约束。
4. 如果新增 tool，同步更新对应 skill，而不是只写 tool description。
5. 如果能力出现在用户能力全景中，更新根 `README.md`。
6. 运行相关测试和 `pnpm run release:pack`，确认 `skills/` 被打包。

内容锚点测试应 pin 契约，不要逐字 pin 整篇文档，否则正常措辞改进会制造无价值测试失败。

## 6. 系统提示词实现

当前常驻 persona 位于：

```text
packages/skills/sentry-persona/
├── src/
│   ├── index.ts
│   └── persona.md
└── tests/sentry-persona.test.ts
```

插件通过 `inject = ['systemPrompt']` 注册 section。当前 `sentry-persona` 的 `order = 10`，位于 harness identity 之后、tool guidance 之前。

新增常驻内容时优先判断：

- 属于现有故障调查员行为宪法：修改 `persona.md`。
- 属于独立部署能力且有独立所有者：新建提示词插件，并明确唯一 section 名和顺序。
- 只在某类任务生效：写成 skill，不新增常驻 section。

## 7. 系统提示词约束

- section 名必须稳定、唯一，可用于诊断和测试。
- order 必须有设计依据，不通过极大/极小值盲目抢优先级。
- 常驻文本保持精简，避免随 tool 数量线性增长。
- 不写入环境 endpoint、tokenRef 值、模型配置或本机路径。
- 不承诺实现没有提供的工具、审批或安全能力。
- 与 guard 的分工是“引导模型行为”，不能代替执行层强制门禁。
- 修改后通过 `ctx.systemPrompt.assemble()` 验证 section 确实进入最终组装，而非只检查 Markdown 存在。

## 8. 评审问题

- 这条指令真的需要常驻吗，还是按需 skill 更合适？
- skill 的触发条件和跳过条件是否清楚？
- 文档中的 tool、参数和证据语义是否与代码一致？
- 是否把环境选择错误地交给普通证据 tool 参数？
- 是否引入了真实秘密、过期 CLI 或不存在的文件路径？
- 新 skill 是否会被 filesystem provider 发现并通过发布包验证？
