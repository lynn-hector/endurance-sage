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

键名约定 `<SYSTEM>_<ENV>_<FIELD>`；平台级数据源（zadig、tapd）无环境段。每行环境引用哪些键，权威来源是 `apps/agent/envs.yml`（`use-env` 切换前按腿校验就绪，缺值或空值只降级对应腿、不拦截切换）。

凭据库有两种形态，就绪校验（`use-env` 与 `sentry_env_list` / `sentry_env_switch`，实现共享于 `@dsh-sentry/env-matrix`）对两种都识别：

- **手工新建的平铺键**（如上例）；
- **dsh GUI 管理的嵌套形态**（`version` / `refs` / `records`，凭据键在 `refs:` 之下）。

往已有文件补键时保持该文件原有形态即可；历史事故：只读顶层键的旧版校验会把嵌套形态下的一切环境误判为缺凭据。

凭据库同时承载**机器本地配置键**，这类键不是机密，放这里能让“一台机器只配一个文件”；dsh 宿主只解析被 `*Ref` 引用的键，其余键由 dsh-sentry 读取，互不影响。

- `DSH_SENTRY_CODE_BASE`：代码检索腿 backend 组的检出根目录，整体优先级为 `envs.yml` 行内值 > 环境变量 > 凭据库，空值继续回退。行内团队配置可进入装配；环境变量与凭据库只在服务构造期解析，不进入装配，修改后重启宿主生效、无需 regenerate。引导 clone 见 [onboarding.md](onboarding.md) 第 4 步。
- `DSH_SENTRY_DEFAULT_ENV`：新 Session 的默认环境偏好（canonical 环境名或短名），优先级高于装配环境 `defaultEnv`；未设置或失效（矩阵漂移）时使用装配环境。Web 设置页「环境与凭据」通过独立的非机密设置 Remote 展示具体环境名、实际生效值和来源，并可直接编辑/清除本机偏好；`env-binding` 每次解析现读文件，偏好变更后下一个新 Session 生效、无需重启，不改写装配文件，语义详见 [env-switching.md](env-switching.md)。
- `DSH_SENTRY_CODE_BASE`：代码检索腿的全局本机路径。Web 设置页在「全局配置」卡片展示实际解析出的路径；Zadig OpenAPI token 等所有环境共用的键也在同一卡片展示配置状态（不展示 token 值）。

## 各数据源 token 获取方式

### Zadig（长期 OpenAPI token）

Zadig 页面右上角头像 → 个人设置 → OpenAPI → 创建 token。**不要**从浏览器开发者工具复制请求头里的 token——那是 dex 登录会话 token，约 1 小时过期（历史教训见 [incidents/2026-08-25-zadig-token.md](../incidents/2026-08-25-zadig-token.md)）。

键名：`ZADIG_API_TOKEN`。插件是纯 HTTP OpenAPI 客户端，**不需要安装 zadig CLI**。

（可选便利项，与插件无关）本机 zadig CLI 可复用同一 token：`~/.zshrc` 里从凭据库动态读取（`ZADIG_API_HOST` + `ZADIG_API_TOKEN`），不明文落第二份。注意 `zadig auth login` 在公司服务端版本上必然 404（CLI 依赖的新端点服务端没有），凭据只能走环境变量。

### TAPD

个人令牌：TAPD 网页 → 我的设置 → 个人访问令牌。权限跟账号项目角色走，无需管理员审批。插件直连 `api.tapd.cn`，**不需要安装官方 `mcp-server-tapd`**（已评估否决）。键名：`TAPD_TOKEN`。细节见 [integrations/tapd-integration.md](../integrations/tapd-integration.md)。

### GreptimeDB（connect token 模式）

部分实例发放 dashboard connect token 链接（`…/#/connect?token=…`）。凭据库只存 **token 本身**（`#/connect?token=` 后面的 base64url 串，不存整条 URL）：dashboard 的 `/#/token-generator` 页面生成，本质是 AES 加密的账密，服务端解密后走 Basic。envs.yml 对应环境腿配 `tokenRef`（省略 usernameRef/passwordRef）；token 内 host 与环境 endpoint 不一致时以 envs.yml 为准并告警。

注意：加密密钥内嵌于公开的 dashboard bundle，token 只是一层混淆——connect 链接应与明文密码同等对待，不要贴进聊天或文档。

### GreptimeDB / Grafana / dbx / RocketMQ

每环境独立或跨环境复用的实测结论记录在 `apps/agent/envs.yml` 头部注释；密码值不入库。

### Kubernetes（网关桥接，当前免鉴权）

K8s 视图腿经平台级 kubernetes-mcp-server 网关（Rancher 多集群 kubeconfig）只读取数：集群凭据、`read_only` 强制与 Secret 拦截全部在服务端一次解决，**本机凭据库目前无需任何键**。网关启用鉴权后，envs.yml 每行 kubernetes 腿补 `tokenRef`（Bearer token），该腿自动进入逐环境就绪推导与切换预检。网关侧加鉴权（token/OIDC）或 IP 白名单仍在推进中——在落地前，能路由到网关的内网客户端都可读全部集群资源。

## 换 token 的操作

只需修改本机 `~/.dsh/.credentials.yaml`，不需要修改环境矩阵、npm 包或 bundle。保存后重启宿主即可；本地链接开发也可以按现有 profile patch 热重载机制触发重载。

不要在 DSH 进程运行期间重装其正在使用的依赖：本地符号链接模式下不要对仓库执行 `pnpm install`，引入模式下不要对 `~/.dsh/profiles/web` 执行安装，以免触发 patch 热重载问题。GitLab 版本升级同样应先停止 DSH。

## 插件与部署边界

普通用户只安装统一的 `@dsh-sentry/sentry` bundle，不需要逐插件维护凭据装配。自研插件由维护者在 `packages/` 和 `renderEntries()` 中增加，再通过 `pnpm run sync:release` 纳入统一 bundle；不要把新包直接加入 `apps/profile/package.json` 作为发布流程。

本地安装、GitLab 发布和版本升级统一见[开发验证、发布与安装](development-release-install.md)。服务器常驻运行见 [deploy.md](deploy.md)。
