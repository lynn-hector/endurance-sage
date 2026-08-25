# git-guard：危险 git 命令双层门禁

> 状态：已上线（deny/ask/allow 三路径真机验证）· 2026-08-25
> 代码：`packages/guard/git-guard/`

## 设计

利用 DSH 工具流水线的两个拦截扩展点，对 bash 工具命令字符串做两层策略：

```
命令进入工具流水线
  ├─ 方案 A：tools/pre-execute 瀑布（可协商层）
  │    ├─ deny：破坏性命令 → 直接拒绝
  │    └─ ask：影响远端 → 审批弹窗（GUI 上人工确认）
  └─ 方案 B：ctx.tools.guard() 终审（不可逾越层）
       └─ deny-only：绝对红线 → 即使其他插件在 pre-execute 放行，依然拒绝
```

方案 B 的存在是关键：guard 只有拒绝和弃权两种结果，**listener 顺序无法复活被拒绝的操作**——将来任何插件意外放行危险命令，终审依然拦截。

## 规则分级（默认值）

| 级别 | 命令 | 行为 |
|---|---|---|
| 硬红线（A deny + B guard） | `reset --hard`、`clean`、`push --force`/`-f`/`--force-with-lease`、`branch -D`、`checkout -- <path>`、`restore`、`filter-branch` | 直接拒绝，审批也无效 |
| A deny（无 B 兜底） | `reflog expire`、`submodule deinit` | 直接拒绝 |
| ask | 普通 `push`、`remote remove/rm/set-url`、`tag -d` | GUI 审批弹窗 |
| allow | 其余 | 放行 |

## 配置

挂载于 `apps/agent/envs.yml` → `render.ts` 生成的 patch（不随环境切换）。四个可调项（`denyPatterns` / `askPatterns` / `hardDenyPatterns` / `toolNames`），默认值在 `packages/guard/git-guard/src/index.ts`；正则编译在插件加载时 fail-loud。

探针工具 `git_guard_status` 返回各层规则加载数，用于验证插件活着。

## 已知局限（明示）

对命令字符串做正则匹配是**防误操作护栏，不是安全边界**：引用展开（`git p"u"sh`）、变量拼接、间接调用（`sh -c "$(…)"`）可绕过。绝对防逃逸要靠 DSH 的 sandbox/escalation 层兜底。规则写宽（匹配子命令名）比写死精确模式更难绕。

## 验证方式

- 冒烟：`node_modules/.bin/tsx packages/guard/git-guard/src/smoke.ts`（模拟完整流水线，含"pre-execute 放行但 guard 拒绝"的分层证明）
- 真机：无害仓库跑 `git clean -nd`（应拒）、`git push --dry-run`（应弹审批）、`git status`（应放行）
