/**
 * Alertmanager v2 REST client (active alerts + silences) behind Grafana's
 * legacy datasource proxy (`/api/datasources/proxy/uid/<uid>/api/v2/...`).
 * NOTE: this is NOT the same mechanism service-prometheus uses — the
 * Grafana `alertmanager` datasource plugin does not serve its backend API
 * through the modern `/api/datasources/uid/<uid>/resources/...` passthrough
 * (DP0 实测 2026-10-13: resources 路径返回插件级 500
 * `plugin.requestFailureError`，legacy proxy 返回真实告警数组；prometheus
 * 类型数据源两者皆通，故 prometheus 侧用 modern 路径)。不要"统一"到
 * resources 路径——先在真实环境验证 AM 数据源插件支持。
 *
 * The Alertmanager knows routing, not rule definitions: `/api/v2/alerts`
 * returns fired instances (with endsAt/fingerprint/receivers — fields the
 * Prometheus rules API lacks), never the PromQL expression. Rule lookup
 * stays on service-prometheus `rules()`.
 *
 * Auth reuses the grafana leg credentials: no Bearer token configured means
 * username/password buys a `grafana_session` via form login
 * (GrafanaSessionKeeper, the service-trace mechanism), cached in memory
 * with a 24h TTL and refreshed once on 401/403.
 *
 * @module @dsh-sentry/service-alertmanager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  authRetryGetJson,
  credentialRefField,
  endpointField,
  GrafanaSessionKeeper,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '@dsh-sentry/datasource'

/** Plugin configuration; the schema defaults optional fields at load time. */
export interface Config {
  /** Grafana base URL, e.g. `https://grafana.cn-1.dev.novo-one.com`. */
  grafanaEndpoint: string
  /** Alertmanager datasource uid inside Grafana, default `alertmanager`. */
  datasourceUid?: string
  /** Credential reference for the login username (grafana leg). */
  usernameRef?: string
  /** Credential reference for the login password (grafana leg). */
  passwordRef?: string
  /** Literal username fallback when no reference is configured. */
  username?: string
  /** Literal password fallback when no reference is configured. */
  password?: string
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** In-memory `grafana_session` TTL in milliseconds. Defaults to 24h. */
  sessionTtlMs?: number
}

export class AlertmanagerService extends Service {
  static Config: z<Config> = z.object({
    grafanaEndpoint: endpointField('Grafana 地址；Alertmanager 经其数据源代理暴露'),
    datasourceUid: z.string().default('alertmanager').description('Grafana 内 Alertmanager 数据源 uid，默认 alertmanager'),
    usernameRef: credentialRefField('表单登录用户名的凭据引用（grafana 腿）'),
    passwordRef: credentialRefField('表单登录密码的凭据引用（grafana 腿）'),
    username: secretField('内联用户名（credential ref 优先；不推荐写在组合文件）'),
    password: secretField('内联密码（credential ref 优先；不推荐写在组合文件）'),
    timeoutMs: timeoutMsField(30_000),
    sessionTtlMs: z.number().step(1).min(1).default(24 * 3600 * 1000)
      .description('grafana_session 内存缓存 TTL（毫秒），默认 24 小时'),
  })

  readonly grafanaEndpoint: string
  /** Grafana 内 Alertmanager 数据源 uid（schema 默认后），供证据 refs 引用。 */
  readonly datasourceUid: string
  private readonly keeper: GrafanaSessionKeeper
  private readonly config: Config

  constructor(ctx: Context, config: Config = { grafanaEndpoint: '' }) {
    super(ctx, 'alertmanager')
    this.grafanaEndpoint = (config.grafanaEndpoint ?? '').replace(/\/+$/, '')
    this.datasourceUid = config.datasourceUid ?? 'alertmanager'
    this.config = config
    this.keeper = new GrafanaSessionKeeper({
      grafanaEndpoint: this.grafanaEndpoint,
      resolveCredentials: async () => {
        let username: string | undefined
        let password: string | undefined
        if (config.usernameRef !== undefined) username = await resolveCredential(ctx, config.usernameRef)
        if (config.passwordRef !== undefined) password = await resolveCredential(ctx, config.passwordRef)
        username ??= config.username
        password ??= config.password
        if (!username || !password) return undefined
        return { username, password }
      },
      timeoutMs: config.timeoutMs ?? 30_000,
      sessionTtlMs: config.sessionTtlMs,
    })
    ctx.effect(() => () => this.keeper.clearSession())
  }

  /** Constructed active-alerts request, for tests and dry-run evidence. */
  buildAlertsRequest(): { url: string } {
    return {
      url: `${this.grafanaEndpoint}/api/datasources/proxy/uid/${this.datasourceUid}/api/v2/alerts`,
    }
  }

  /** Constructed silences request, for tests and dry-run evidence. */
  buildSilencesRequest(): { url: string } {
    return {
      url: `${this.grafanaEndpoint}/api/datasources/proxy/uid/${this.datasourceUid}/api/v2/silences`,
    }
  }

  /** Active (firing/resolved-not-yet-expired) alert instances. */
  async listAlerts(): Promise<unknown> {
    return authRetryGetJson(this.keeper, this.buildAlertsRequest().url, {
      timeoutMs: this.config.timeoutMs ?? 30_000,
      label: 'Alertmanager',
    })
  }

  /** All silences (active and expired); filter client-side. */
  async listSilences(): Promise<unknown> {
    return authRetryGetJson(this.keeper, this.buildSilencesRequest().url, {
      timeoutMs: this.config.timeoutMs ?? 30_000,
      label: 'Alertmanager',
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    alertmanager: AlertmanagerService
  }
}

export default AlertmanagerService
