# 凭据管理

dsh-sentry 的全部凭据走**引用**（`*Ref` 字段），值只存于本机凭据库，不入仓库。

## 凭据库

位置：`~/.dsh/.credentials.yaml`（dsh 进程以此解析所有 `tokenRef` / `usernameRef` / `passwordRef`）。

```yaml
GREPTIMEDB_DP0_USERNAME: <grafana 用户>
GREPTIMEDB_DP0_PASSWORD: <密码>
ZADIG_API_TOKEN: <长期 OpenAPI token>
TAPD_TOKEN: <token>
...
```

键名约定 `<SYSTEM>_<ENV>_<FIELD>`；平台级数据源（zadig、tapd）无环境段。每行环境引用哪些键，权威来源是 `apps/agent/envs.yml`（`use-env` 切换前会校验全部键就绪，缺一个拒绝切换）。

凭据库有两种形态，就绪校验（`use-env` 与 `sentry_env_list` / `sentry_env_switch`，实现共享于 `@dsh-sentry/env-matrix`）对两种都识别：

- **手工新建的平铺键**（如上例）；
- **dsh GUI 管理的嵌套形态**（`version` / `refs` / `records`，凭据键在 `refs:` 之下）。

往已有文件补键时保持该文件原有形态即可；历史事故：只读顶层键的旧版校验会把嵌套形态下的一切环境误判为缺凭据。

凭据库同时承载**机器本地配置键**（当前只有 `DSH_SENTRY_CODE_BASE`——代码检索腿的仓库根目录，优先级 `envs.yml` > 环境变量 > 凭据库）。这类键不是机密，但放这里能让"一台机器只配一个文件"；dsh 宿主只解析被 `*Ref` 引用的键，其余键对它不可见、互不影响。

## 各数据源 token 获取方式

### Zadig（长期 OpenAPI token）

Zadig 页面右上角头像 → 个人设置 → OpenAPI → 创建 token。**不要**从浏览器开发者工具复制请求头里的 token——那是 dex 登录会话 token，约 1 小时过期（历史教训见 [incidents/2026-08-25-zadig-token.md](../incidents/2026-08-25-zadig-token.md)）。

键名：`ZADIG_API_TOKEN`。插件是纯 HTTP OpenAPI 客户端，**不需要安装 zadig CLI**。

（可选便利项，与插件无关）本机 zadig CLI 可复用同一 token：`~/.zshrc` 里从凭据库动态读取（`ZADIG_API_HOST` + `ZADIG_API_TOKEN`），不明文落第二份。注意 `zadig auth login` 在公司服务端版本上必然 404（CLI 依赖的新端点服务端没有），凭据只能走环境变量。

### TAPD

个人令牌：TAPD 网页 → 我的设置 → 个人访问令牌。权限跟账号项目角色走，无需管理员审批。插件直连 `api.tapd.cn`，**不需要安装官方 `mcp-server-tapd`**（已评估否决）。键名：`TAPD_TOKEN`。细节见 [integrations/tapd-integration.md](../integrations/tapd-integration.md)。

### GreptimeDB / Grafana / dbx / RocketMQ

每环境独立或跨环境复用的实测结论记录在 `apps/agent/envs.yml` 头部注释；密码值不入库。

## 换 token 的操作

只需改 `~/.dsh/.credentials.yaml` 一处，然后触发 profile patch 重载（touch 或重新生成 `cordis.patch.yml`）。**不要**在 dsh 进程运行时动 profile 的 `node_modules`——独立 profile（符号链接模式）下不要对**仓库**跑 `pnpm install`，引入模式下不要对 `~/.dsh/profiles/web` 跑——会卡死 patch 热重载（事故记录见 incidents）。

## 给 profile 挂新插件包

单一事实来源：[onboarding.md](onboarding.md) 的「给 sentry profile 加插件（SOP）」一节。要点：先看插件包带不带自带 `cordis.patch.yml`——第三方插件装依赖即自动装配（**不要**再手工注册条目，会 `duplicate loader entry id` 启动失败）；自研 `@dsh-sentry/*` 包才走 renderEntries + regenerate 全流程。凭据相关的 `*Ref` 引用配置见本文上文。

部署全流程见 [deploy.md](deploy.md)。
