# Zadig token 认证问题排查记录（2026-08-25）

## 问题

`sentry_query_zadig` 工具持续 401，被归因为「Zadig token 过期」。

## 根因（两层）

1. **token 类型错了**：`envs.yml` 的 `tokenRef: ZADIG_DEX_TOKEN` 引用的是浏览器 dex 登录会话 token，约 1 小时过期，需要人工从浏览器刷新覆盖——不可持续。
2. **服务端拒绝裸 token**：`https://zadig.yeastardigital.com` 的 OpenAPI 只接受 `Authorization: Bearer <token>`，裸 token 一律 401。

## 解决

- 改用 **Zadig 个人设置创建的长期 OpenAPI token**（JWT `exp=2126`，不会过期）。
- 凭据库 `~/.dsh/.credentials.yaml` 统一用键名 **`ZADIG_API_TOKEN`**，删除了 `ZADIG_DEX_TOKEN`。
- `envs.yml`、`sentry.cordis.patch.yml`、`~/.dsh/profiles/web/cordis.patch.yml`（dsh 实际加载的 live 文件，patch watcher 热重载）、`render.test.ts`、`probe.ts` 的引用全部改为 `ZADIG_API_TOKEN`。
- 服务插件 `packages/services/zadig/src/index.ts` 已使用 `Authorization: Bearer` 头，无需改动。

## zadig CLI（@koderover/zadig-cli 0.1.5）的坑

- `zadig auth login` / `zadig auth check` **必然失败**（`status=404`）：这两个命令依赖较新版 Zadig 服务端的校验端点，公司服务端版本较旧没有该端点。这是 CLI 与服务端版本不匹配，**不是 token 无效**。
- 业务命令（`project list`、`env`、`workflow` 等）全部正常，凭据通过环境变量提供：

```bash
export ZADIG_API_HOST=https://zadig.yeastardigital.com
export ZADIG_API_TOKEN=<长期 OpenAPI token>
```

- 因此本地 CLI 无法持久化 profile（`~/.zadig` 始终 "no profile is configured"），每次新 shell 需要环境变量（可写入 `~/.zshrc`）。
- 服务端 OpenAPI 路径无 `/v1` 前缀（如 `/openapi/projects/project/detail`），带 `/v1` 的路径全部 `Invalid path`。

## token 如何获取

Zadig 页面右上角头像 → 个人设置 → OpenAPI → 创建 token。**不要**从浏览器开发者工具复制请求头里的 token（那是 dex 会话 token，1 小时过期）。

## 残留问题

- `zadig skill install` 失败：`~/.npm` 存在 root 属主文件，需 `sudo chown -R $(id -u):$(id -g) ~/.npm` 后重试。
- 若将来升级公司 Zadig 服务端到与 CLI 匹配的版本，可恢复 `zadig auth login` 持久化 profile 的正常用法。
