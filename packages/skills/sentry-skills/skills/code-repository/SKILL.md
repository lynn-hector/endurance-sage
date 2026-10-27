---
name: code-repository
description: 跨仓代码检索、读取与 ff-only 同步：sentry_search_code（codegraph 索引优先、ripgrep 回退）+ sentry_read_code + sentry_sync_code（git pull --ff-only 刷新配置仓库，更新后自动增量重建 codegraph 索引）。从错误信息/日志行/慢 SQL 定位到代码行，作为交叉验证的 code 证据。
---

# code-repository：跨仓代码检索、读取与同步

## 使用边界

在产品代码仓库中定位与异常、错误信息或功能相关的代码片段。触发场景：

- 根据错误信息/日志行/慢 SQL 搜索相关代码。
- 其他排查技能（db/redis/trace）定位到可疑调用后，回到代码确认逻辑。
- 需要读取指定文件片段。
- 本地检出疑似落后（行号/内容对不上），需要 ff-only 同步。

跳过场景：

- 只讨论代码架构，没有具体检索目标。

执行原则：

- 只读：搜索和读取（sentry_search_code / sentry_read_code），不修改任何文件。
- 同步：sentry_sync_code 仅对配置发现的仓库执行 `git pull --ff-only`——只快进、不合并、不重写历史、不丢本地改动；本地分叉或工作区不干净时以错误回报而不是强行同步。快进后自动增量重建该仓的 codegraph 索引（失败不影响同步结果）。只允许操作配置内仓库（repos/baseDir/repoPath 发现到的），不接受任意路径。
- 优先返回带行号上下文的代码片段。
- 搜索结果为空时，缩短关键词或换同义词重试；怀疑检出滞后（行号对不上、代码不存在）时先 sentry_sync_code 同步再重试。

为什么是工具而不是模型直接读文件：会话沙箱把原生文件工具限制在会话工作区内，产品仓库在别处；工具在宿主进程内执行受控只读检索，是对沙箱的受控豁免。sentry_sync_code 同在宿主进程执行、不经 bash 管线（git-guard 拦不到它），因此护栏内建于工具本身：固定参数的 `git pull --ff-only` + 只操作配置发现的仓库，模型无法注入命令或指定任意路径。

来源纪律：代码腿的检索根目录（baseDir，regenerate 时从 `DSH_SENTRY_CODE_BASE` 烘焙）与对话工作区互不相干。不要把会话工作区里的检出当代码事实来源——两者版本/行号可能漂移；代码证据一律以 `sentry_search_code` / `sentry_read_code` 返回为准。

## 工具

### sentry_search_code — 跨仓搜索

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | 是 | - | 搜索关键词或错误信息（固定字符串、大小写不敏感） |
| `repo` | 否 | 全部 | 限定仓库（名称或路径） |
| `language` | 否 | - | 语言过滤：go/python/java/typescript/javascript/proto/sql/yaml/json |
| `maxResults` | 否 | `20` | 最大返回片段数 |

搜索后端（自动选择）：仓库有 `.codegraph/` 索引 → `codegraph query --json`（索引损坏或无结果时回退）；否则 → `ripgrep`，语言 glob 过滤，±2 行上下文，相邻匹配区间合并。

### sentry_read_code — 读取文件

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repo` | 是 | - | 仓库名（搜索结果里的 `repo` 字段）或路径 |
| `file` | 是 | - | 相对仓库根的文件路径 |
| `startLine` | 否 | `1` | 起始行（1 起） |
| `endLine` | 否 | 文件末 | 结束行 |

返回带行号前缀的文件内容；先搜索后读取，确认片段的完整上下文。

### sentry_sync_code — 同步仓库（ff-only）

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repo` | 否 | 全部 | 限定一个**配置内**仓库（名称或配置路径）；不能指定任意目录 |
| `dryRun` | 否 | `false` | 只列出目标仓库的当前分支/HEAD，不执行 pull |

对配置发现到的仓库执行 `git pull --ff-only`：只快进；本地分叉、工作区不干净、无上游时返回该仓库的 git 错误，不做任何合并/重置/丢弃。每仓结果含 `head_before → head_after`（短 sha）、分支名与 git 输出摘要；有更新（或下述自愈触发）的仓库若带 `.codegraph/` 索引，会接着跑增量 `codegraph sync --quiet` 刷新索引（结果记在每仓的 `index_sync`/`index_error`，失败不影响 pull 结果，搜索无结果时仍会回退 ripgrep）。

什么时候用：行号/内容与日志或链路证据对不上、怀疑本地检出落后于部署版本时，先同步再重新搜索。

索引自愈：clone-repos 在装有 codegraph 的机器上会为每个仓库自动初始化索引并记录建索引时的 HEAD（`.git/dsh-codegraph-head`）。sentry_sync_code 每次运行会将该标记与当前 HEAD 比对——切分支、手工 pull 等任何带外变更导致不一致时自动重建该仓索引（哪怕本次 pull 无更新；pull 失败不阻断自愈）。重建失败时标记保持旧值，下次 sync 自动重试，期间检索回退 ripgrep。

## 输出格式

统一 evidence 信封，`type: code`，`source: code-repository`。搜索结果 `data.results[]` 每项含 `repo/file/line_start/line_end/content/score`（score 仅 codegraph 路径有值，rg 路径恒 0）。仓库未配置时 `confidence: 0` 并带配置提示。

## 使用示例

```json
{ "query": "timeout connecting to redis" }
```

```json
{ "query": "GetConfig", "repo": "novo-commctl-config", "language": "go", "maxResults": 5 }
```

```json
{ "repo": "novo-commctl-config", "file": "internal/data/redis.go", "startLine": 40, "endLine": 60 }
```

## 推荐链路

1. 从日志/链路/慢 SQL 中提取错误信息或函数名。
2. `sentry_search_code` 跨仓搜索（结合 project-context 技能的仓库布局判断去哪个仓）。
3. 结果为空或行号对不上时：先 `sentry_sync_code` 同步（或缩短关键词重试）。
4. `sentry_read_code` 读取关键片段的完整上下文。
5. 代码片段作为 code 证据参与交叉验证（"日志 + 代码"两类证据定根因）。

## 检查清单

- [ ] 查询关键词是否足够具体。
- [ ] 是否返回了带行号的代码片段。
- [ ] 证据可疑时是否先 sentry_sync_code 同步过再下结论。
- [ ] 是否结合了错误信息或 trace 上下文。
- [ ] 是否说明了代码片段与异常的相关性。
