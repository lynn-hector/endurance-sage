# 代码索引与同步细节

本资料解释 `code-repository` 的检索来源和索引维护机制。日常搜索只需阅读主 SKILL；索引异常、版本漂移或同步结果异常时阅读本文。

## 1. 为什么使用专用工具

会话沙箱将原生文件工具限制在会话工作区，而产品仓库通常位于其他目录。`sentry_search_code` 和 `sentry_read_code` 在宿主进程内提供受控检索，不允许模型借此读取任意路径。

代码检索根目录由服务配置解析：行内团队配置可以进入装配，机器路径来自环境变量或凭据库，不进入对话。检索根目录与会话工作区互不相干，因此两边版本和行号可能不同。

`sentry_sync_code` 也在宿主进程执行，不经过 bash 管线。安全边界由工具内建：固定 `git pull --ff-only`，只操作配置发现的仓库，不接受任意路径或额外 git 参数。

## 2. 搜索后端

- 仓库存在 `.codegraph/` 索引时，优先执行 `codegraph query --json`。
- 索引损坏或无结果时可回退 ripgrep；没有索引时直接使用 ripgrep。
- ripgrep 按 language 映射 glob，返回匹配位置上下各 2 行，并合并相邻区间。
- codegraph 路径可返回 score；ripgrep 结果的 score 恒为 0，不代表相关性为零。

搜索无结果应先检查查询词和仓库范围。索引回退是检索机制，不是代码不存在的证据。

## 3. 同步与索引自愈

`sentry_sync_code` 对目标仓库执行 ff-only pull，并返回每仓的 `head_before → head_after`、分支名和 git 输出摘要。失败时保留错误，不做合并、重置或丢弃改动。

clone-repos 在装有 codegraph 的机器上会初始化索引，并在 `.git/dsh-codegraph-head` 记录建索引时的 HEAD。每次同步都会比较该标记与当前 HEAD：

- pull 有更新时，对带 `.codegraph/` 的仓库执行增量 `codegraph sync --quiet`。
- 切分支、手工 pull 等带外变化造成 HEAD 不一致时，即使本次 pull 无更新，也会触发索引重建。
- pull 失败不阻断可进行的索引自愈。
- 索引结果记录在每仓的 `index_sync` / `index_error`；失败不影响 pull 结果，标记保持旧值以便下次重试，期间搜索回退 ripgrep。

## 4. 版本解释

同步解决的是“本地检出是否落后”，不解决“本地最新是否等于线上运行版本”。历史故障需要结合部署证据确定实际版本；如果运行版本早于当前 HEAD，最新代码中的修复或重构不能用于解释故障时的行为。
