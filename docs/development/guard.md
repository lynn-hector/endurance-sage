# Guard 开发

> Guard 在工具执行 pipeline 中实施横切策略。它用于防止不允许的执行，不用于替代业务参数校验，也不把提示词当作安全边界。

## 1. 何时使用 Guard

适合：

- 某类 tool 或参数字段需要统一拦截。
- 危险操作需要人工审批。
- 绝对红线必须在所有 pre-execute listener 之后再次拒绝。
- 策略需要跨多个 tool 一致执行。

不适合：

- 只属于一个 tool 的必填参数或取值组合校验。
- 后端查询语法和业务空结果处理。
- 可用 service 权限、最小凭据或 sandbox 更直接解决的问题。
- 仅希望模型“尽量不要做”的行为引导；这属于系统提示词或 skill。

## 2. DSH 两层扩展点

当前 git-guard 使用两层：

```text
工具调用
  → tools/pre-execute 瀑布
      → allow：继续后续 listener
      → ask：进入人工审批
      → deny：拒绝执行
  → ctx.tools.guard() 终审
      → 返回拒绝原因：最终拒绝
      → 返回 undefined：弃权，不主动允许
  → 实际 tool execute
```

职责分工：

- **pre-execute**：完整的 allow / ask / deny 策略，可通过 `next()` 让后续 listener 参与。
- **terminal guard**：deny-only 的绝对红线。即使之前 listener 或审批允许，也不能复活 hard deny。

普通可审批操作不要全部塞入 terminal guard，否则会失去审批路径；真正不可协商的红线也不能只放在可被后续决策覆盖的层。

## 3. 策略定义

实现前先列出策略矩阵：

| 操作类别 | pre-execute | terminal guard | 理由 |
|---|---|---|---|
| 普通只读操作 | next / allow | undefined | 无额外风险 |
| 影响共享或远端、可人工确认 | ask | undefined | 允许责任人判断 |
| 破坏性、不可直接执行 | deny | 视红线级别 | 明确阻止 |
| 绝对禁止、审批也不能放行 | deny | 拒绝原因 | 防止其他 listener 意外放行 |

每条规则必须有明确对象、匹配字段、风险级别和测试用例。不要先写宽泛正则再反推策略。

## 4. 实现契约

Guard 包通常使用函数插件并声明：

```ts
export const name = 'sentry-example-guard'
export const inject = ['tools']
```

实现要求：

- 只扫描声明的 tool 名和参数字段；不相关调用必须 `next()` / `undefined` 直通。
- pre-execute 不吞掉其他 listener：无命中时调用并返回 `next()`。
- terminal guard 不返回“允许”，只返回拒绝原因或 `undefined`。
- 拒绝原因说明命中策略和未执行事实，不包含秘密。
- Config 中的规则在加载阶段编译和校验；非法配置应 fail-loud，而不是带着空规则运行。
- 安全关键策略默认 fail-closed；可用性策略是否 fail-open 必须显式评审。
- 注册监听器和 guard 的生命周期由 Cordis 管理，不创建无法释放的全局副本。
- 若提供状态探针，只暴露规则数量或非敏感元数据，并明确它是诊断能力。

## 5. 规则与匹配

对命令字符串做正则匹配只能作为防误操作护栏：

- 引用、变量拼接、间接解释器和编码可能改变实际命令。
- 匹配过窄容易绕过，过宽又可能拦截正常调查。
- `bash` 等通用执行工具不能仅靠 guard 成为完整安全边界。

因此必须：

1. 在文档中写明匹配语言和已知绕过方式。
2. 对危险能力同时使用最小权限、sandbox、后端授权或资源隔离。
3. 对 pipeline、子 shell、不同字段和非目标 tool 增加测试。
4. 不把“正则未命中”表述为“命令已证明安全”。

如果新策略可以基于结构化参数而不是命令字符串实施，优先使用结构化参数。

## 6. 配置与注册

- 规则默认值属于 guard 包，环境无关的 guard 在 `renderEntries()` 注册一次。
- 可配置项必须有 schema、默认值和说明。
- 不让某个 Env 的切换意外关闭全局安全红线。
- 规则变更需要同步 `docs/architecture/git-guard.md` 或新 guard 的专题文档。
- 状态探针不能替代真实 pipeline 测试。

## 7. 最小测试集

至少验证：

1. 不相关 tool 和不相关参数原样通过。
2. 普通允许案例到达 `next()`。
3. ask 案例返回审批决策。
4. deny 案例不执行 tool。
5. hard deny 在另一个 listener 已 allow 后仍被 terminal guard 拒绝。
6. ask 被人工允许后，如果命中 hard deny，仍不能执行。
7. 非法正则或配置在加载时明确失败。
8. 多个规则同时命中时决策优先级稳定。
9. 命令变体、管道、子 shell 和非字符串字段按声明语义处理。
10. 拒绝原因不泄漏秘密，状态探针不暴露敏感配置。

现有参考：

- 实现：`packages/guard/git-guard/src/index.ts`。
- 分层冒烟：`packages/guard/git-guard/src/smoke.ts`。
- 架构和局限：`docs/architecture/git-guard.md`。

## 8. 评审问题

- 策略是否真的需要横切 guard，而不是 tool 校验或权限配置？
- allow / ask / deny 和 hard deny 是否有明确区分？
- 是否证明其他 listener 的 allow 无法越过绝对红线？
- 是否测试了不相关调用直通，避免 guard 成为全局阻塞点？
- 是否把字符串匹配误称为完整安全边界？
- 配置失败、规则优先级和生命周期是否有可重复验证？
