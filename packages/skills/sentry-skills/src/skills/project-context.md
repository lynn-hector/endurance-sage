# project-context：项目背景、架构与部署

排查前加载本文档，理解故障影响面、关键路径、服务边界和部署拓扑。

## 项目概述

| 项目 | 说明 |
|---|---|
| 项目名称 | 通话配置服务（novo-commctl） |
| 业务域 | 通信 / 通话控制 / 音视频配置 |
| 主要功能 | 通话策略、配置下发、状态控制、呼叫路由 |
| 服务等级 | 核心，7x24 |

## 服务清单

`novo-one` 项目下的 Go 微服务集合（Kratos v2 框架，gRPC + HTTP，Wire 依赖注入；数据层 PostgreSQL/GORM + Redis；消息 RocketMQ；定时 xxl-job；观测 OpenTelemetry + Prometheus + Zap 日志自动注入 trace_id/tenant_code；配置中心 Nacos）：

| 服务 | 主要职责 | 关键程度 |
|---|---|---|
| novo-commctl-autop | 话机自动开通/预配：模板、固件、镜像配置下发 | 核心 |
| novo-commctl-call-control | 呼叫控制逻辑，核心通话状态管理 | 核心 |
| novo-commctl-config | 配置管理、下发与同步（依赖 Nacos 同步到边缘） | 核心 |
| novo-commctl-orbit | 轨道/路由调度（影响呼叫路由与策略执行） | 核心 |
| novo-commctl-layout | 布局/界面配置 | 重要 |
| novo-commctl-report | 报表/统计（依赖 PG 和 xxl-job） | 重要 |
| novo-commctl-telecom-template（novo-telecom-template） | 电信/号码模板（影响呼叫路由） | 重要 |
| novo-commctl-util / novo-commctl-kit | 公共工具库 / 公共框架能力 | 中 |
| novo-common-proto | 公共 Protobuf 定义 | 中 |
| rocketmq | RocketMQ 客户端封装 | 中 |

## 关键用户旅程（排查优先级）

1. **通话创建与配置下发**：网关 → call-control/config → 读 Nacos 配置 → 写 PG 通话记录 → 发 RocketMQ 状态事件 → 边缘同步。失败＝无法通话/配置不生效。优先查：Nacos 同步、PG 写入延迟、RocketMQ 发送延迟、Redis 击穿。
2. **通话状态查询**：网关 → call-control → Redis 缓存 → 回源 PG。优先查：缓存命中率、PG 慢查询、连接池。
3. **呼叫路由与策略执行**：SBC/WebSocket → orbit/call-control → 读模板 → 路由决策 → 状态回写。优先查：Nacos 一致性、模板服务、RocketMQ 消费延迟。
4. **报表统计与定时任务**：xxl-job → report → 查 PG。优先查：执行器心跳、PG 长事务、任务堆积。
5. **话机自动开通**：账号/租户 MQ 事件 → autop → 生成预配数据 → Provision 接口下发。优先查：MQ 消费堆积、Nacos 同步、Provision 可用性。

## 常见故障模式（历史经验，快速建立假设）

1. 配置下发延迟/不一致：Nacos 同步异常或 MQ 消费延迟。
2. RocketMQ 消息积压：消费慢或分区不足，状态更新不及时。
3. Redis 缓存失效/击穿：热点配置缓存失效 → PG 压力激增。
4. GreptimeDB 日志查询慢：日志量突增或索引问题。
5. xxl-job 调度失败：配置刷新/统计汇总/模板同步中断。
6. 话机预配失败：MQ 事件消费异常、Provision 不可用。
7. PostgreSQL 慢查询/连接池耗尽。
8. 跨服务延迟：网络抖动、下游超时。

## 失败模式与恢复

| 故障点 | 典型症状 | 人工恢复动作 |
|---|---|---|
| PG 主库故障 | 写入失败、查询变慢 | 切换后确认一致性、查连接池 |
| Redis 故障 | 查询延迟升高、PG 压力增大 | 重启/扩容 Redis、限流保护 PG |
| RocketMQ 积压 | 消费延迟、状态不同步 | 扩容消费者、清理死信 |
| Nacos 故障 | 配置下发失败 | 检查集群、回滚异常配置 |
| MinIO 故障 | 文件上传下载失败 | 检查存储集群、切换 bucket |
| xxl-job 失败 | 定时任务未触发 | 检查执行器、补偿执行 |
| GreptimeDB 慢 | 日志平台响应慢 | 缩小查询时间范围、查索引 |

## 部署拓扑

多环境部署，域名结构 `{组件前缀}.{region-code}.{环境域}`。环境清单（节选）：

| 环境 | 标识 | 域名后缀 | 托管 |
|---|---|---|---|
| 研发-平台托管 0 | dev-platform-hosted-0 | cn-0.dev.novo-one.com | 平台 |
| 研发-平台托管 1 | dev-platform-hosted-1 | cn-1.dev.novo-one.com | 自管 |
| 研发-客户自托管 0 | dev-client-hosted-0 | cn-0.dev-byoi.novo-one.com | BYOI |
| 测试-平台托管 0/1 | tst-platform-hosted-0/1 | cn-0/1.test.novo-one.com | 平台/自管 |
| 测试-客户自托管 0 | tst-client-hosted-0 | cn-0.test-byoi.novo-one.com | BYOI |
| 性能-客户自托管 1/2 | sit-client-hosted-1/2 | cn-1/2.sit-byoi.novo-one.com | BYOI |
| 音质测试 | sqt-client-hosted-0 | cn-0.sqt-byoi.novo-one.com | BYOI |
| 预演 | pre-client-0 | cn-0.pre-byoi.novo-one.com | BYOI |
| GCP 香港测试 | novo-asia-east2-a-0 | gke-hk-0.test.novo-one.com | 平台 |
| 巴西/德国/美国/新加坡测试 | sae-0 / sae-1 / de-0 / us-0 / sg-0 | *.test.novo-one.com | 混合 |

组件域名前缀：`api`（接口）、`sip`（SBC WebSocket）、`account`（LB）、`edge0/edge1`（边缘直连 + STUN）、`dbx`（数据库管理后台）、`rnacos`（配置中心）、`emqx`（MQTT）、`minio`、`xxl-job`、`rocketmq`、`greptimedb`、`grafana`。

发布流程：Git → CI（Zadig 工作流）→ 镜像构建推送 → Helm Chart 渲染 → K8s 滚动更新 → 健康检查。部署状态与最近发布用 zadig-inspector 技能查询。

## 排查范围与边界

- **负责范围**：novo-commctl 各服务及直接依赖的 PG、Redis、RocketMQ、Nacos、MinIO、xxl-job、GreptimeDB、Prometheus/Alertmanager。
- **不直接负责**：K8s 集群底层、网络基础设施、运营商链路、客户端 SDK（可关联，不承担修复主责）。
- **权限**：只读查询日志/指标/链路/DB/Redis/MQ；禁止写操作与变更。线上配置变更、数据修复、重启、回滚、DDL 需人工审批。

## 升级路径

| 场景 | 升级到 |
|---|---|
| 基础设施故障（K8s/网络/存储） | 基础设施值班群 |
| DB/缓存/MQ 集群故障 | 中间件值班群 |
| 安全事件 | 安全团队 |
| 业务决策（资损/补偿/数据修复） | 产品/业务负责人 |
