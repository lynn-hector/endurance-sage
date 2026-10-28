---
name: code-repository
description: 跨仓代码检索、读取与按需 ff-only 同步：sentry_search_code 定位错误、函数或 SQL 相关代码，sentry_read_code 读取带行号上下文，sentry_sync_code 仅在版本疑似滞后时刷新配置内仓库并更新索引。
---

# code-repository：跨仓代码检索、读取与同步

## 使用边界

用于把日志异常、慢 SQL、trace 中的调用位置或用户提供的功能点定位到产品代码，并取得带行号的证据。

触发场景：

- 根据错误文本、函数名、SQL 或调用点搜索代码。
- 读取搜索结果或指定文件的完整上下文。
- 有明确迹象表明本地检出落后于目标版本，需要同步后重新核对。

跳过场景：只讨论代码架构而没有具体检索目标。

执行原则：

- 搜索和读取是只读操作，不修改文件。
- 代码事实以 `sentry_search_code` / `sentry_read_code` 的产品仓库检出为准，不使用会话工作区中的同名仓库替代。
- 优先返回能解释异常的上下文，不把代码存在或文本相同直接当作运行时根因。
- 搜索为空先缩短关键词、换同义词或调整 repo/language；只有行号、符号或版本明显对不上时才考虑同步，不把同步当作普通空结果的默认动作。

## 工具

### sentry_search_code — 跨仓搜索

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | 是 | - | 固定字符串搜索，大小写不敏感 |
| `repo` | 否 | 全部 | 限定配置内仓库，名称或路径 |
| `language` | 否 | - | go/python/java/typescript/javascript/proto/sql/yaml/json |
| `maxResults` | 否 | `20` | 最大返回片段数 |

有 `.codegraph/` 索引时优先 codegraph，无索引、索引损坏或需要回退时使用 ripgrep。返回带行号上下文的片段。

### sentry_read_code — 读取文件

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repo` | 是 | - | 搜索结果中的仓库名或配置路径 |
| `file` | 是 | - | 相对仓库根的文件路径 |
| `startLine` | 否 | `1` | 起始行，1 起 |
| `endLine` | 否 | 文件末 | 结束行 |

先搜索再读取关键片段，确认条件分支、调用关系和异常处理上下文。

### sentry_sync_code — 按需同步仓库

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repo` | 否 | 全部配置内仓库 | 同步目标；怀疑单个仓库滞后时应明确指定 |
| `dryRun` | 否 | `false` | 只返回目标仓库当前分支和 HEAD，不执行 pull |

同步会对配置内仓库执行 `git pull --ff-only`，不是只读查询。它只快进，不合并、不重置、不丢弃本地改动；分叉、工作区状态或上游问题按错误返回。只允许操作配置发现的仓库，模型不能指定任意路径或注入命令。

有更新或索引 HEAD 不一致时会尝试增量重建 codegraph；索引失败不改变 pull 结果，搜索仍可回退 ripgrep。详细规则见 [索引与同步细节](references/index-and-sync.md)。

## 输出与证据语义

统一 evidence 信封，`type: code`，`source: code-repository`。搜索结果的 `data.results[]` 含 `repo/file/line_start/line_end/content/score`；score 仅 codegraph 路径有值，ripgrep 路径恒 0。仓库未配置时 confidence 为 0 并带配置提示。

- 搜索为空只表示当前关键词、仓库和本地版本未命中，不证明代码或功能不存在。
- 本地代码能解释异常只是代码证据，还需确认它是否属于实际部署版本，并与日志、trace 或指标对齐。
- 同步后的最新代码也不一定等于故障时运行版本；排查历史故障应结合 Zadig 的镜像、分支或 commit。

## 使用示例

```json
{ "query": "timeout connecting to redis", "language": "go", "maxResults": 10 }
```

```json
{ "repo": "novo-commctl-config", "file": "internal/data/redis.go", "startLine": 40, "endLine": 60 }
```

## 推荐链路

1. 从日志、链路或慢 SQL 提取具有区分度的错误文本、函数名或 SQL 片段。
2. 搜索代码，必要时用 `project-context` 确认仓库布局。
3. 读取关键片段，说明代码路径与异常之间的关系和仍缺少的运行时证据。
4. 搜索为空时先调整查询；只有版本疑似滞后时先 dryRun 核对 HEAD，再按需同步。
5. 将代码与日志、trace、指标或部署版本交叉验证。

## 检查清单

- [ ] 查询关键词是否具体，空结果是否先尝试了合理变体。
- [ ] 是否读取了带行号的必要上下文，而非只凭搜索摘要。
- [ ] 是否区分本地代码、最新代码与实际部署版本。
- [ ] 是否仅在版本疑似滞后时同步，并限制到目标仓库。
- [ ] 是否用运行时证据验证代码所提示的因果路径。
