# code-repository：跨仓代码检索与读取

## 使用边界

在产品代码仓库中定位与异常、错误信息或功能相关的代码片段。触发场景：

- 根据错误信息/日志行/慢 SQL 搜索相关代码。
- 其他排查技能（db/redis/trace）定位到可疑调用后，回到代码确认逻辑。
- 需要读取指定文件片段。

跳过场景：

- 只讨论代码架构，没有具体检索目标。

执行原则：

- 只读：搜索和读取，不修改任何文件。
- 优先返回带行号上下文的代码片段。
- 搜索结果为空时，缩短关键词或换同义词重试。

为什么是工具而不是模型直接读文件：会话沙箱把原生文件工具限制在会话工作区内，产品仓库在别处；工具在宿主进程内执行受控只读检索，是对沙箱的受控豁免。

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
3. 结果为空时缩短关键词重试。
4. `sentry_read_code` 读取关键片段的完整上下文。
5. 代码片段作为 code 证据参与交叉验证（"日志 + 代码"两类证据定根因）。

## 检查清单

- [ ] 查询关键词是否足够具体。
- [ ] 是否返回了带行号的代码片段。
- [ ] 是否结合了错误信息或 trace 上下文。
- [ ] 是否说明了代码片段与异常的相关性。
