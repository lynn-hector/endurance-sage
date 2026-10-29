---
name: kubernetes-inspector
description: 只读查询当前会话环境的 Kubernetes 视图——Pod 状态、容器日志、事件与任意资源对象（sentry_query_k8s_pods / sentry_read_k8s_pod_logs / sentry_list_k8s_events / sentry_query_k8s_resource）。集群随 Session 环境自动路由；Pod 状态与事件是异常证据，仍需与日志/链路/指标交叉验证。
---

# kubernetes-inspector：查询 Kubernetes 运行视图

## 使用边界

用于收集集群层运行证据。触发场景：

- 服务异常（CrashLoopBackOff、Pending、重启、OOM）需要看 Pod 实际状态与放置。
- 需要容器日志定位崩溃或错误输出，尤其是上一个实例的临终日志。
- 需要集群事件（BackOff、FailedScheduling、探针失败、驱逐）判断异常波及面。
- 需要 Deployment/StatefulSet/Service/Ingress/ConfigMap/PVC 等对象的实时 spec 与 status。

跳过场景：只需要部署流水线与镜像版本（用 zadig-inspector）；只需要应用日志检索与聚合（用 log-analyzer——K8s pod 日志同样进 GreptimeDB，优先用日志腿做模式分析，本技能的 pod 日志用于补容器级细节）。

执行原则：

- 只读。网关侧 `read_only` 强制，Secret 被 denied_resources 拦截；本技能不存在任何写操作。
- **不要传、也传不了 context/集群参数**：工具自动绑定当前 Session 环境对应的集群，查错环境是不可能的。看到别的环境的线索时，先提示用户确认，再 `sentry_env_switch`。
- 大命名空间注意翻页：`data.remaining_item_count` 大于 0 时用 `data.continue` 作为 `continueToken` 取下一页。
- 生产环境（pro-*）查询同样只读，但日志可能含敏感信息，引用时只摘录必要行。

## 工具

### sentry_query_k8s_pods — Pod 列表 / 单 Pod 详情

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `pod` | 否 | - | 提供时返回该 Pod 完整对象（容器状态、镜像、节点）；省略时列命名空间 Pod 行 |
| `namespace` | 否 | 环境业务命名空间 | 目标命名空间 |
| `labelSelector` | 否 | - | 标签选择器，如 `app.kubernetes.io/name=commctl-config` |
| `fieldSelector` | 否 | - | 字段选择器，如 `status.phase=Failed` |
| `limit` | 否 | `100` | 行数上限 1–200 |
| `continueToken` | 否 | - | 上一页 `data.continue` 的翻页令牌 |

列表行是网关压平的字段：`Name/Status/Ready/Restarts/Age/IP/Node/Labels`。summary 会点名非 Running 的数量。

### sentry_read_k8s_pod_logs — 容器日志

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `pod` | 是 | - | Pod 名（先用 pods 工具拿候选） |
| `namespace` | 否 | 环境业务命名空间 | 目标命名空间 |
| `container` | 否 | Pod 默认容器 | 指定 sidecar 等具体容器 |
| `tail` | 否 | `100` | 末尾行数，上限 2000 |
| `previous` | 否 | `false` | 取上一个已终止实例的日志——崩溃后重启的临终日志 |

返回 `data.logs` 原文与 `line_count`。需要按时间窗过滤或跨服务聚合时改用 log-analyzer。

### sentry_list_k8s_events — 集群事件

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `namespace` | 否 | 全集群 | 省略时扫全会话集群（波及面视图）；提供时限定命名空间 |
| `fieldSelector` | 否 | - | 如 `type=Warning`、`involvedObject.name=<pod>` |
| `limit` | 否 | `100` | 条数上限 1–200 |
| `continueToken` | 否 | - | 翻页令牌 |

事件行字段：`Namespace/Timestamp/Type/Reason/InvolvedObject/Message`。summary 统计 Warning 条数。

### sentry_query_k8s_resource — 任意资源对象

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apiVersion` | 是 | - | 如 `apps/v1`、`v1`、`networking.k8s.io/v1` |
| `kind` | 是 | - | 如 `Deployment`、`Service`、`Ingress`、`ConfigMap`、`PersistentVolumeClaim` |
| `name` | 否 | - | 提供时返回完整实时对象；省略时列该类资源行 |
| `namespace` | 否 | 列表模式不限 | 命名空间型资源的范围 |
| `labelSelector` | 否 | - | 列表模式标签过滤 |
| `limit` | 否 | `50` | 列表模式行数上限 1–200 |

Deployment 行包含 `Ready/Up-to-date/Available/Images/Selector`，可核对镜像版本与 Zadig 发布记录是否一致。

## 输出与证据语义

统一 evidence 信封，`type: kubernetes`，`source: kubernetes-inspector`；`data.env`、`data.context`、`backend_ref` 标记来源集群。失败时 confidence 为 0，`data.error` 带原因（网关不可达、context 失效、资源被拒等）。

- **Pod 非 Running / 高重启**：是集群层异常的直接证据，但不解释业务层根因；结合 `previous` 日志与事件确认崩溃原因。
- **事件 Warning（BackOff/探针失败）**：说明控制面观测到异常，仍需定位是应用、配置还是资源问题。
- **Pod 全部 Running**：不证明业务健康，也不排除版本回归。
- **资源 spec 正常**：不能排除运行时故障；status 与事件要一起看。
- **容器日志无错误**：不等于该 Pod 无异常——可能日志已轮转或错误在别的容器/上一个实例。

## 使用示例

列默认命名空间的 Pod：

```json
{}
```

取崩溃容器的临终日志：

```json
{ "pod": "commctl-sip-5d8f7c9b4-x2plm", "previous": true, "tail": 300 }
```

看全集群 Warning 事件：

```json
{ "fieldSelector": "type=Warning", "limit": 50 }
```

核对某 Deployment 的实时镜像与副本：

```json
{ "apiVersion": "apps/v1", "kind": "Deployment", "name": "commctl-config" }
```

## 推荐排查路径

1. `sentry_query_k8s_pods` 定位异常 Pod（非 Running、重启多），记下节点与调度信息。
2. `previous: true` 取临终日志；同时 `sentry_list_k8s_events` 用 `involvedObject.name` 过滤该 Pod 的事件。
3. Pod 一直 Pending/驱逐时看节点与 PVC：`sentry_query_k8s_resource` 查 Node/PVC；镜像不符时与 zadig 发布记录对账。
4. 拿到的现象（崩溃、OOM、配置错）回到 log-analyzer / trace-analyzer / metrics-inspector 做跨证据验证，再下根因结论。

## 检查清单

- [ ] 是否让集群跟随 Session 环境，没有手工指定任何 context。
- [ ] 崩溃类问题是否取了 `previous` 日志与对应事件。
- [ ] 大列表是否用翻页令牌核对 `remaining_item_count`，没有把"第一页没看到"当成"不存在"。
- [ ] 是否把集群层证据与日志/链路/指标交叉验证，而不是单凭 Pod 状态下结论。
