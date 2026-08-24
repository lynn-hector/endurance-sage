# endurance-sentry → Cordis 插件化重构计划

> 状态：已评审（2026-08-24）｜目标仓库：`dsh-sentry`｜原仓库：`/Users/yangfm/workspace/work/endurance-sentry`（保持不动，作为参照）

## 1. 背景与现状评估

### 1.1 原项目本质

endurance-sentry 是一个**无运行时的静态能力包**：Markdown 规范 + Python 脚本的集合，约定由外部 Agent（Hermes）读取 `SKILL.md` 后用 Bash 调用脚本：

```
Hermes(外部) → 读 SKILL.md → Bash 调 scripts/*.py → stdout 输出 evidence JSON
```

- 无包管理：根目录无 `package.json` / `pyproject.toml`；脚本只用 Python 标准库，零依赖。
- 无测试实现：`tests/` 只有一个 README 和一个 fixture；README 引用的还是 `.sh` 脚本，与实际 `.py` 不符。
- 无生命周期：每次调用都是进程冷启动，连接、鉴权缓存无法跨调用复用。

### 1.2 结构清点

| 部分 | 内容 | 规模 |
|---|---|---|
| `skills/` | 8 个 skill：log-analyzer、trace-analyzer、db-inspector、redis-inspector、mq-inspector、metrics-inspector、code-repository、zadig-inspector | 脚本 ~4200 行 Python |
| `skills/lib/` | 共享库：config（自写简化 YAML 解析器）、evidence、dbx、auth_cache | ~900 行 |
| `templates/` | 6 个输出模板（evidence-format 是核心契约） | 纯 Markdown |
| `config/` | 3 个环境 YAML：数据源声明 + `secrets_ref` 引用环境变量 | — |
| `docs/` | methodology 2 篇 + project 4 篇 | 纯知识库 |
| `agents/` | design-reviewer（与 AIOps 无关） | 1 个文件 |
| `scripts/` | sync-hermes-skills.py（软链到 `~/.hermes/skills`） | 201 行 |

### 1.3 文档与实际的漂移（迁移时必须修正）

- README 列 7 个 skill，实际 8 个（zadig-inspector 未登记）；
- README 提到 `docs/fragments/`、`tools/`，目录不存在；
- AGENTS.md 引用 `docs/methodology/general-troubleshooting.md`，文件不存在；
- tests README 引用 `.sh` 脚本，实际全是 `.py`；
- `lib/config.py` 的占位符正则 `(?::- (?P<default>[^}]*) )?` 写法可疑，`${VAR:-default}` 默认值语法很可能实际失效。

### 1.4 已确认的决策

| 决策点 | 结论 |
|---|---|
| 技术栈 | 全部用 TypeScript 重写（原生 Cordis 插件） |
| 落地位置 | 新仓库 `dsh-sentry`（原仓库保持不动） |
| 宿主运行时 | 集成进 DSH (deepseek-harness)，使用其 vendored Cordis 生态 |

## 2. 重构映射设计

### 2.1 DSH / Cordis 机制 ↔ 原项目概念

| DSH / Cordis 机制 | 对应 endurance-sentry 概念 |
|---|---|
| 插件四件套：`export const name / inject / Config / apply(ctx, config)` | 每个 skill 目录 |
| Config 用 `@deepseek-ai/schemastery` 声明，带 schema 校验和默认值 | `config/{env}.yml` + 自写 YAML 解析器（淘汰） |
| `z.string().role('secret')` / `role('credential-ref')` + `dsh-credentials` 服务 | `secrets_ref` + 环境变量注入 |
| `class X extends Service` + `declare module '@deepseek-ai/cordis'` 增强 `Context` | `skills/lib/`（config/evidence/dbx/auth_cache） |
| `defineTool`（`@deepseek-ai/dsh-tools`）注册 agent 工具 | 脚本命令行接口（`--service --env --start ...`） |
| `ctx.skills.register()`（`dsh-skill`），模型经 `skill` 工具按需加载 | SKILL.md + prompts/usage.md + methodology.md |
| `installSettingsSection` 热加载用户配置 | `~/.endurance-sentry/config/` 覆盖机制 |
| `cordis.yml` + loader 声明式组装插件树 | sync-hermes-skills.py 的软链加载 |

### 2.2 核心架构原则

原项目内容干净地拆成两层：

- **给模型看的指令**（SKILL.md / methodology / prompts / templates）→ 注册进 DSH 的 skill registry，模型按需加载；
- **真正干活的查询逻辑**（`scripts/*.py`）→ 重写为 TS Service + agent 工具，模型调用带 JSON Schema 的工具，参数校验在 schema 层完成，不再需要模型拼 20 多个命令行参数。

### 2.3 目标目录结构

```text
dsh-sentry/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
├── cordis.yml                        # 演示/开发用插件组装（含 agent preset）
├── packages/
│   ├── core/
│   │   ├── evidence/                 # evidence 构建/校验（替代 lib/evidence.py）
│   │   └── datasource/               # 数据源解析、环境选择、credential-ref 桥接
│   ├── services/                     # 数据源客户端，每个是一个 Cordis Service
│   │   ├── greptimedb/               # 日志（替代 fetch_logs.py）
│   │   ├── trace/                    # Grafana-Jaeger / Jaeger 原生
│   │   ├── postgres/                 # db-inspector
│   │   ├── redis/                    # dbx-redis
│   │   ├── rocketmq/                 # mq-inspector（含 console API）
│   │   ├── prometheus/               # metrics + alerts
│   │   └── zadig/                    # 发布/环境查询
│   ├── tools/                        # agent 工具插件（defineTool），依赖对应 service
│   │   ├── tool-log-analyzer/
│   │   ├── tool-trace-analyzer/
│   │   ├── tool-db-inspector/
│   │   ├── tool-redis-inspector/
│   │   ├── tool-mq-inspector/
│   │   ├── tool-metrics-inspector/
│   │   ├── tool-code-repository/
│   │   └── tool-zadig-inspector/
│   └── skills/
│       └── sentry-skills/            # 启动时把 8 个 SKILL.md 注册进 ctx.skills
├── content/                          # 从原仓库迁移的纯 Markdown 资产
│   ├── skills/  ├── templates/  ├── docs/methodology/  └── docs/project/
└── presets/                          # AGENTS.md 人格/安全红线 → DSH persona/preset
```

## 3. 分阶段计划

### Phase 0 — 骨架与机制验证（风险前置）

- 搭建 pnpm monorepo + tsconfig + vitest，跑通空插件。
- 验证三个未知点：
  1. `@deepseek-ai/cordis` / `dsh-tools` / `dsh-credentials` / `schemastery` 能否从外部仓库引用（npm 已发布？还是 `file:` 指向本地 DSH checkout / vendor 方式）；
  2. 外部插件如何被 DSH 宿主加载（cordis.yml 的 name 解析路径）；
  3. `defineTool` 注册工具的完整签名与输出 schema 约定。
- **验收**：一个 hello-world 工具插件 + 一个注册的 skill，能在 DSH agent 会话里被调用。

**✅ Phase 0 结果（2026-08-24）**：

1. **外部引用**：所有必需包均已发布到 npm。`@deepseek-ai/cordis@4.0.1`、`cordis-plugin-loader@1.0.2`、`cordis-plugin-include@1.0.6`、`schemastery@3.18.1` 为正式版；`dsh-tools` / `dsh-skill` / `dsh-credentials` / `dsh-system-prompt` 固定在 `0.1.0-rc.7`（与本地 DSH checkout 一致；npm 上已有更新的 0.1.1-rc.2，暂不跟进）。
2. **加载机制**：cordis loader 以 cordis.yml 所在目录为 baseUrl 做 Node 模块解析，外部 npm 包和 workspace 包都能直接按 `name` 加载；`@deepseek-ai/cordis` 自带 `bin.js` CLI（加载 `./cordis.yml`）。两条路径（程序化 `ctx.plugin()` 与声明式 cordis.yml）均已实测通过。
3. **工具约定**：`ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`，插件用 `inject = ['tools', ...]` 声明依赖；`ctx.tools` 由 `dsh-tools` 的 `ToolRuntime`（inject `systemPrompt`）提供，`ctx.skills` 由 `dsh-skill` 的 `SkillRegistry` 提供，`ctx.skills.register()` 注册 Markdown 指令体。
4. 骨架落地：`apps/dev`（`pnpm dev` / `pnpm dev:loader` 双验证入口）+ `packages/tools/tool-hello`（探针插件），typecheck 通过。
5. 遗留：「在真实 DSH agent 会话里被模型调用」依赖 LLM 凭据与完整 agent spine，推迟到 Phase 5 端到端验收；Phase 0 已验证注册链路（工具 schema 进入 `ctx.tools`、skill 进入 `ctx.skills`，即 agent 发现能力的入口）。

### Phase 1 — core：evidence + datasource

- `evidence` 包：evidence-format 契约的 TS 类型 + 构建/校验函数 + 单测（翻译 `lib/evidence.py`，补 schema 校验）。
- `datasource` 包：**不翻译 `lib/config.py`，而是取消其职责**（2026-08-24 设计评审结论）。原自写 YAML 解析器的四个职责分别卸载到 DSH 原生机制：
  1. **YAML 解析** → 不存在了。配置即 cordis.yml 插件条目（include 插件内含 js-yaml），校验/默认值由各数据源插件的 schemastery `Config` 承担；
  2. **多环境** → cordis.patch.yml 层叠（DSH bundle 既定模式）：base 组合声明插件行，`config/{env}.cordis.patch.yml` 按 `id` 覆盖 `config`；
  3. **用户级覆盖**（原 `~/.endurance-sentry/` + global 合并）→ dsh-settings：`installSettingsSection`，落在 `$DSH_HOME/settings.yaml`，热加载；
  4. **凭据注入**（原 `secrets_ref` + 环境变量）→ dsh-credentials：`role('credential-ref')` + `ctx.credentials.resolve()`，凭据永不进配置文件，支持 `credentials/updated` 轮换事件。
  - `${VAR}` 占位符 → loader 的 `!!js` 表达式插值。
  - 架构变化：数据源从「运行期按字符串 id 查字典」变为「装配期类型化注入的 Service」；`--env`、`--datasource-id` 参数随之消失。
  - **已知取舍**：同一宿主进程只装配一个环境；跨环境对照需跑两个宿主实例（原脚本可单次调用切环境）。接受此取舍，如需跨环境再引入"环境实例"概念。
  - `datasource` 包因此缩小为：各数据源插件共享的 Config 辅助（credential-ref 字段约定、endpoint/timeout 公共字段）与类型定义。

### Phase 2 — 样板 skill：log-analyzer 端到端打通

- greptimedb service：HTTP `/v1/sql` 只读查询、字段白名单、过滤 DSL、连接复用、dispose 清理。
- `tool-log-analyzer`：参数从 20 个 CLI flag 收敛为 JSON Schema；输出保持 evidence 契约。
- **对照测试**：同一组输入下，TS 版生成的 SQL 与原 Python 版逐字一致（golden tests，从原 SKILL.md 示例提取）。
- 样板先小范围实测，确认工具 schema 命名/默认值合理后，Phase 3 才铺开。

### Phase 3 — 其余 7 个 skill 按样板铺开

- 顺序：trace-analyzer → metrics-inspector → db-inspector → redis-inspector → mq-inspector → code-repository → zadig-inspector。
- 每个遵循同一模式：service（连接/鉴权/查询）→ tool（schema + evidence）→ golden tests。
- `lib/dbx.py`、`lib/auth_cache.py` 的能力并入对应 service；auth 缓存挂 service 实例，dispose 时清理（常驻进程相对冷启动脚本的直接收益）。
- zadig-inspector 有独立 `requirements.txt`，需单独确认其第三方依赖的 TS 等价物。
- RocketMQ/Nacos/xxl-job/MinIO 在原仓库只有 config 声明没有脚本：**只迁移已有脚本的能力，不虚构新能力**。

### Phase 4 — 知识与人格资产迁移

- `content/`：SKILL.md × 8、methodology、templates、project docs 原样迁移，并修正 §1.3 列出的全部漂移。
- `sentry-skills` 插件：启动时把 8 个 SKILL.md 注册进 `ctx.skills`。
- AGENTS.md 的行为宪法/安全红线 → DSH agent preset 的 persona + 只读约束（配合 DSH 文件沙箱/审批策略落地，不只靠提示词自律）。

### Phase 5 — 宿主集成与验收

- `cordis.yml` 完整组装：settings + credentials + 8 个 tool + skills 包 + persona preset。
- 用 `tests/fixtures/sample-incident.yml` 场景做端到端走查：模型用新工具完成一次"503 排查"，输出符合 evidence 契约。
- 编写 README/AGENTS.md，标注与原仓库的对应关系。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| `@deepseek-ai/*` 包未对外发布，外部仓库无法依赖 | Phase 0 验证；兜底是 `file:` 依赖本地 checkout，或把 dsh-sentry 作为 DSH workspace 成员开发 |
| Python 脚本隐含的数据源行为细节（重试、鉴权头、分页）在翻译时丢失 | 每个 service 配 golden tests，先写对照测试再重写 |
| 工具参数 schema 设计直接影响模型调用质量 | Phase 2 样板先实测，确认后再铺开 |
| 原仓库部分数据源只有声明没有实现 | 保持现状语义，不虚构能力 |

## 5. 与原仓库的关系

- 原仓库 `endurance-sentry` 在整个重构期间**保持不动**，作为行为规范与 golden tests 的数据来源。
- 重构完成后，原仓库可归档；`novo-commctl-*` 只读业务代码引用不属于本次迁移范围（code-repository skill 的搜索目标由新插件的 `repo_path` 配置指定）。
