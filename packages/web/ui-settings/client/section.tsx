/**
 * 环境与凭据 —— settings.section 内容组件。
 *
 * 页面展示默认环境、全局配置和环境列表。环境矩阵中的团队配置只读；
 * 本机偏好与凭据值可在页面上修改。describe 只回状态，页面永不回显
 * 机密凭据值。
 *
 * 交互语言：凭据行平时只显示键名 + 状态，点击行内联展开编辑器
 * （保存/取消在左，破坏性删除分离到展开区右端）；环境详情对话框为
 * 左侧数据源导航 + 右侧内容的 master-detail。视觉语言：状态一律
 * "彩点 + 文字"（不单靠颜色），标签不折行，图标用内联 SVG
 * （currentColor，不引图标库）；按钮 primary 实心 / ghost 描边 /
 * danger 文字型；间距 8px 基准。样式用设置面板的 dsw CSS 变量做
 * 主题适配（亮/暗跟随宿主），注入一次 <style>；不依赖任何 UI 组件库，
 * 保持 client bundle 的 external 面最小（仅 react 系）。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { CODE_BASE_REF, DEFAULT_ENV_REF, legCredentialRefs } from '@dsh-sentry/env-matrix/pure'
import { catalogRefs, chunkRefs, configFields, defaultEnvView, envReadinessViews, globalCredentialViews } from './model.ts'
import type { CredentialStatusMap, EnvReadinessView } from './model.ts'
import { MATRIX } from './generated-matrix.ts'
import type { CredentialInfo, DefaultEnvInfo, GlobalConfigInfo, SettingsSectionOwnerProps } from './types.ts'

const CSS = `
.dshs-page{display:flex;flex-direction:column;gap:12px;font-size:12px;line-height:20px}
.dshs-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;margin:0}
.dshs-legend{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.dshs-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;overflow-wrap:anywhere}
.dshs-icon{width:14px;height:14px;flex-shrink:0;display:inline-block;vertical-align:-2px}

/* ── 卡片 ── */
.dshs-card{border:1px solid var(--dsw-alias-line-1);border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshs-cardTitle{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:11px 16px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-line-1)}
.dshs-cardTitle small{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px;line-height:18px}

/* ── 状态：彩点 + 文字（颜色不是唯一信息载体）── */
.dshs-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:18px;white-space:nowrap;flex-shrink:0;color:var(--dsw-alias-label-secondary)}
.dshs-statusDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex-shrink:0}
.dshs-status.ok .dshs-statusDot{background:var(--dsw-alias-success-fg,#1a7f37)}
.dshs-status.miss{color:var(--dsw-alias-danger-fg,#c62828)}
.dshs-status.miss .dshs-statusDot{background:var(--dsw-alias-danger-fg,#c62828)}
.dshs-pill{display:inline-flex;align-items:center;border-radius:999px;padding:1px 9px;font-size:11px;line-height:18px;white-space:nowrap;flex-shrink:0;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}

/* ── 按钮：primary 实心 / ghost 描边 / danger 文字型 ── */
.dshs-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-line-1);border-radius:var(--dsw-radius-sm,4px);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:3px 12px;flex-shrink:0;color:var(--dsw-alias-label-primary);background:transparent}
.dshs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshs-btn:disabled{opacity:.45;cursor:default}
.dshs-btn:focus-visible{outline:2px solid var(--dsw-alias-accent-bg,#3345ff);outline-offset:1px}
.dshs-btn.primary{border-color:transparent;background:var(--dsw-alias-accent-bg,#3345ff);color:var(--dsw-alias-accent-fg,#fff)}
.dshs-btn.primary:hover:not(:disabled){background:var(--dsw-alias-accent-bg,#3345ff);background:color-mix(in srgb,var(--dsw-alias-accent-bg,#3345ff) 85%,#000)}
.dshs-btn.danger{border-color:transparent;color:var(--dsw-alias-danger-fg,#c62828)}
.dshs-btn.danger:hover:not(:disabled){background:var(--dsw-alias-danger-bg,rgba(198,40,40,.10))}
.dshs-btn.icon{width:28px;padding:3px 0}

/* ── 表单 ── */
.dshs-input{font:inherit;font-size:12px;line-height:18px;min-height:26px;box-sizing:border-box;min-width:120px;flex:1 1 150px;padding:3px 8px;border:1px solid var(--dsw-alias-line-1);border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshs-input:focus{outline:2px solid var(--dsw-alias-accent-bg,#3345ff);outline-offset:-1px;border-color:transparent}
.dshs-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshs-editor{display:flex;flex:1 1 260px;min-width:0;flex-wrap:wrap;align-items:center;gap:8px}
.dshs-editorError{flex-basis:100%;color:var(--dsw-alias-danger-fg,#c62828);font-size:11px;line-height:16px}
.dshs-error{color:var(--dsw-alias-danger-fg,#c62828);font-size:12px;margin:0}

/* ── 默认环境 ── */
.dshs-defaultBody{display:flex;flex-direction:column;gap:8px;padding:12px 16px}
.dshs-defaultPrimary{display:flex;align-items:center;gap:8px;row-gap:8px;flex-wrap:wrap}
.dshs-defaultPrimary .dshs-editor{margin-left:auto}
.dshs-defaultValue{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshs-defaultMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}

/* ── 可展开的凭据/配置行 ── */
.dshs-credItem{display:flex;flex-direction:column}
.dshs-credRow{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;width:100%;padding:10px 16px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background-color .12s ease}
.dshs-credRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshs-credRow:focus-visible{outline:2px solid var(--dsw-alias-accent-bg,#3345ff);outline-offset:-2px}
.dshs-credRowStatic{cursor:default}
.dshs-credRowStatic:hover{background:transparent}
.dshs-credRowMeta{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-shrink:0;flex-wrap:wrap}
.dshs-chevDown{color:var(--dsw-alias-label-tertiary);transition:transform .12s ease,color .12s ease}
.dshs-credItem.open .dshs-chevDown,.dshs-credRow:hover .dshs-chevDown{color:var(--dsw-alias-label-secondary)}
.dshs-credItem.open .dshs-chevDown{transform:rotate(180deg)}
.dshs-credEditor{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-line-1);background:var(--dsw-alias-interactive-bg-hover)}
.dshs-credEditor .dshs-btn.danger{margin-left:auto}

/* ── 全局配置 ── */
.dshs-globalList{display:flex;flex-direction:column}
.dshs-globalList .dshs-credItem+.dshs-credItem{border-top:1px solid var(--dsw-alias-line-1)}
.dshs-globalMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 240px}
.dshs-globalLabel{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshs-globalRef{margin-left:8px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dshs-globalValue{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;overflow-wrap:anywhere;text-align:right}

/* ── 环境列表 ── */
.dshs-envList{display:flex;flex-direction:column}
.dshs-envRow{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;width:100%;padding:10px 16px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background-color .12s ease}
.dshs-envRow+.dshs-envRow{border-top:1px solid var(--dsw-alias-line-1)}
.dshs-envRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshs-envRow:focus-visible{outline:2px solid var(--dsw-alias-accent-bg,#3345ff);outline-offset:-2px}
.dshs-envMain{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.dshs-envName{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.dshs-envMeta{display:flex;align-items:center;gap:8px;flex-shrink:0}
.dshs-chev{color:var(--dsw-alias-label-tertiary);transition:transform .12s ease,color .12s ease}
.dshs-envRow:hover .dshs-chev,.dshs-envRow:focus-visible .dshs-chev{transform:translateX(2px);color:var(--dsw-alias-label-secondary)}

/* ── 环境详情对话框：左导航 + 右内容 ── */
.dshs-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}
.dshs-dialog{display:flex;flex-direction:column;width:min(760px,100%);height:min(640px,85vh);overflow:hidden;border:1px solid var(--dsw-alias-line-1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px rgba(0,0,0,.28)}
.dshs-dialogHeader{position:sticky;top:0;z-index:2;display:flex;flex-shrink:0;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-line-1);background:var(--dsw-alias-bg-layer-1)}
.dshs-dialogTitle{margin:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:15px;font-weight:600;overflow-wrap:anywhere}
.dshs-dialogMeta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:3px}
.dshs-dialogMain{display:flex;flex:1;min-height:0}
.dshs-navCol{width:172px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;padding:8px;border-right:1px solid var(--dsw-alias-line-1);overflow:auto}
.dshs-navItem{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:color .12s ease,background-color .12s ease}
.dshs-navItem:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshs-navItem.active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);font-weight:500;box-shadow:inset 2px 0 0 var(--dsw-alias-accent-bg,#3345ff)}
.dshs-navItem:focus-visible{outline:2px solid var(--dsw-alias-accent-bg,#3345ff);outline-offset:-2px}
.dshs-navSep{margin:6px 4px;border-top:1px solid var(--dsw-alias-line-1)}
.dshs-navSpacer{width:6px;height:6px;flex-shrink:0}
.dshs-contentCol{flex:1;min-width:0;overflow:auto;padding:14px 18px}
.dshs-dialogFooter{flex-shrink:0;padding:8px 18px;border-top:1px solid var(--dsw-alias-line-1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}

/* ── 内容面板 ── */
.dshs-sourcePanel{border:1px solid var(--dsw-alias-line-1);border-radius:8px;overflow:hidden}
.dshs-sourcePanel:focus-visible{outline:2px solid var(--dsw-alias-accent-bg,#3345ff);outline-offset:-2px}
.dshs-panelHeader{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-line-1);font-size:12.5px;font-weight:600}
.dshs-fields{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);gap:6px 16px;margin:0;padding:12px 14px;font-size:12px;line-height:20px}
.dshs-fields dt{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshs-fields dd{margin:0;overflow-wrap:anywhere;font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.dshs-fieldsGroup+.dshs-fieldsGroup{border-top:1px solid var(--dsw-alias-line-1)}
.dshs-fieldsGroup>.dshs-refLabel{display:block;padding:10px 14px 0}
.dshs-refs{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-line-1)}
.dshs-refs>.dshs-refLabel{padding:10px 16px 0}
.dshs-refs .dshs-credItem+.dshs-credItem{border-top:1px solid var(--dsw-alias-line-1)}
.dshs-refLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500}
`

const LEG_NAMES = ['greptimedb', 'grafana', 'prometheus', 'dbx', 'rocketmq', 'zadig', 'kubernetes'] as const

type LegName = (typeof LEG_NAMES)[number]

const LEG_LABELS: Record<LegName, string> = {
  greptimedb: 'GreptimeDB',
  grafana: 'Grafana',
  prometheus: 'Prometheus',
  dbx: 'dbx',
  rocketmq: 'RocketMQ',
  zadig: 'Zadig',
  kubernetes: 'Kubernetes',
}

/** 对话框导航页：数据源腿 + 一页通用配置（数据库 / 代码仓库）。 */
type DialogTab = LegName | 'general'

const NAV_ITEMS: { key: DialogTab; label: string }[] = [
  ...LEG_NAMES.map(name => ({ key: name as DialogTab, label: LEG_LABELS[name] })),
  { key: 'general', label: '通用配置' },
]

function styleInject(css: string): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById('dsh-sentry-ui-settings-style')
  if (existing !== null) return
  const element = document.createElement('style')
  element.id = 'dsh-sentry-ui-settings-style'
  element.textContent = css
  document.head.append(element)
}

interface Remote {
  describe(refs: string[]): Promise<{ ok: true; value: Record<string, CredentialInfo> } | { ok: false; error: { message: string } }>
  set(ref: string, value: string): Promise<{ ok: true } | { ok: false; error: { message: string } }>
  unset(ref: string): Promise<{ ok: true } | { ok: false; error: { message: string } }>
  getDefaultEnv(): Promise<{ ok: true; value: DefaultEnvInfo } | { ok: false; error: { message: string } }>
  getGlobalConfig(): Promise<{ ok: true; value: GlobalConfigInfo } | { ok: false; error: { message: string } }>
}

/** 拉取环境列表和详情所需的状态，分批 describe，一次失败整体降级为错误条。 */
async function fetchStatus(remote: Remote): Promise<CredentialStatusMap> {
  const refs = catalogRefs(MATRIX)
  const merged: CredentialStatusMap = {}
  for (const chunk of chunkRefs(refs)) {
    const response = await remote.describe(chunk)
    if (!response.ok) throw new Error(response.error.message)
    Object.assign(merged, response.value)
  }
  return merged
}

/** 状态指示：彩点 + 文字。颜色不是唯一载体，dot 为装饰（aria-hidden）。 */
function Status({ state, children }: { state: 'ok' | 'miss' | 'neutral'; children: ReactNode }) {
  return (
    <span className={`dshs-status ${state}`}>
      <span className="dshs-statusDot" aria-hidden="true" />
      {children}
    </span>
  )
}

/** 内联图标（currentColor / aria-hidden），避免引入图标库依赖。 */
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={`dshs-icon ${className ?? ''}`} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={`dshs-icon ${className ?? ''}`} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="dshs-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 可展开的凭据/配置行：平时只有左侧内容 + 状态点，点击整行展开编辑器；
 * 保存/取消在左，破坏性删除分离到展开区右端。机密值只写不读；非机密
 * 路径可回显当前值。宿主供应（不可写）的键渲染为静态行。
 */
function CredentialItem({ remote, credentialRef, info, initialValue, secret, left, rightExtras, onChanged }: {
  remote: Remote
  credentialRef: string
  info: CredentialInfo | undefined
  initialValue?: string
  secret: boolean
  /** 行左侧内容（键名，或全局配置的名称+说明块）。 */
  left: ReactNode
  /** 状态点左侧的附加内容（如代码根目录的实际值）。 */
  rightExtras?: ReactNode
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const readOnly = info !== undefined && !info.writable

  useEffect(() => {
    if (!open) return
    setValue(initialValue ?? '')
    setError(undefined)
    inputRef.current?.focus()
  }, [open, initialValue])

  const close = useCallback(() => setOpen(false), [])

  const save = useCallback(async () => {
    if (busy || value.trim() === '') return
    setBusy(true)
    setError(undefined)
    const response = await remote.set(credentialRef, value.trim())
    setBusy(false)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setOpen(false)
    onChanged()
  }, [busy, credentialRef, onChanged, remote, value])

  const remove = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    const response = await remote.unset(credentialRef)
    setBusy(false)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setOpen(false)
    onChanged()
  }, [busy, credentialRef, onChanged, remote])

  const status = info === undefined
    ? <Status state="neutral">状态未知</Status>
    : <Status state={info.configured ? 'ok' : 'miss'}>{info.configured ? '已配置' : '未配置'}</Status>

  if (readOnly) {
    return (
      <div className="dshs-credItem">
        <div className="dshs-credRow dshs-credRowStatic">
          {left}
          <span className="dshs-credRowMeta">
            {rightExtras}
            {status}
            <span className="dshs-legend">由宿主供应，不可修改</span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={`dshs-credItem ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="dshs-credRow"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
      >
        {left}
        <span className="dshs-credRowMeta">
          {rightExtras}
          {status}
          <ChevronDownIcon className="dshs-chevDown" />
        </span>
      </button>
      {open && (
        <div className="dshs-credEditor">
          <input
            ref={inputRef}
            className="dshs-input"
            type={secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            aria-label={secret ? `${credentialRef} 的新值` : `${credentialRef} 的路径`}
            placeholder={secret ? '输入新值（保存前不回显）' : '输入本机路径'}
            value={value}
            disabled={busy}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void save()
              if (event.key === 'Escape') close()
            }}
          />
          <button type="button" className="dshs-btn primary" disabled={busy || value.trim() === ''} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" className="dshs-btn" disabled={busy} onClick={close}>取消</button>
          {info?.configured === true && (
            <button type="button" className="dshs-btn danger" disabled={busy} onClick={() => void remove()}>
              {busy ? '删除中…' : '删除'}
            </button>
          )}
          {error !== undefined && <span className="dshs-editorError">{error}</span>}
        </div>
      )}
    </div>
  )
}

/** 默认环境卡片：展示实际生效值，并编辑本机偏好键（仅影响新 Session）。 */
function DefaultEnvCard({ remote, info, readiness, onChanged }: {
  remote: Remote
  info: DefaultEnvInfo
  readiness: EnvReadinessView[]
  onChanged: () => void
}) {
  const view = defaultEnvView(info)
  const [selection, setSelection] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const selectionValue = selection === '' ? view.preference ?? '' : selection
  const preferenceMissing = view.preference !== undefined
    && !readiness.some(item => item.env === view.preference)

  const save = useCallback(async () => {
    if (busy || selection === '' || selection === view.preference) return
    setBusy(true)
    setError(undefined)
    const response = await remote.set(DEFAULT_ENV_REF, selection)
    setBusy(false)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setSelection('')
    onChanged()
  }, [busy, onChanged, remote, selection, view.preference])

  const clear = useCallback(async () => {
    if (busy || view.preference === undefined) return
    setBusy(true)
    setError(undefined)
    const response = await remote.unset(DEFAULT_ENV_REF)
    setBusy(false)
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    setSelection('')
    onChanged()
  }, [busy, onChanged, remote, view.preference])

  const metaParts = [
    `偏好键 ${DEFAULT_ENV_REF}：${view.preference ?? '未设置'}`,
    `装配环境 defaultEnv：${view.assemblyEnv ?? '未知'}`,
    view.preference !== undefined && view.preference !== view.effectiveEnv
      ? '本机偏好已失效，当前使用装配环境'
      : undefined,
    '保存后下一个新 Session 生效；在线 Session 用 sentry_env_switch 切换',
  ].filter((part): part is string => part !== undefined)

  return (
    <div className="dshs-card">
      <div className="dshs-cardTitle">
        默认环境
        <small>新 Session 的初始环境，不影响已打开的 Session</small>
      </div>
      <div className="dshs-defaultBody">
        <div className="dshs-defaultPrimary">
          <span className="dshs-defaultValue">{view.effectiveEnv ?? '未知'}</span>
          <span className="dshs-pill">{view.source === 'preference' ? '来自本机偏好' : '来自装配环境'}</span>
          <div className="dshs-editor">
            <select
              className="dshs-input"
              aria-label="选择默认环境"
              value={selectionValue}
              disabled={busy}
              onChange={event => setSelection(event.target.value)}
            >
              <option value="">选择环境…</option>
              {preferenceMissing && view.preference !== undefined && (
                <option value={view.preference}>{view.preference}（当前保存，矩阵未识别）</option>
              )}
              {readiness.map(item => (
                <option key={item.env} value={item.env}>
                  {item.env}
                  {item.aliases.length > 0 ? `（${item.aliases.join('/')}）` : ''}
                  {item.ready ? ' — 凭据就绪' : ` — 缺 ${item.missingRefs.length} 项凭据`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="dshs-btn primary"
              title="保存本机偏好"
              disabled={busy || selection === '' || selection === view.preference}
              onClick={() => void save()}
            >
              {busy ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="dshs-btn"
              title="清除本机偏好"
              disabled={busy || view.preference === undefined}
              onClick={() => void clear()}
            >
              清除
            </button>
            {error !== undefined && <span className="dshs-editorError">{error}</span>}
          </div>
        </div>
        <p className="dshs-defaultMeta">{metaParts.join(' · ')}</p>
      </div>
    </div>
  )
}

/** 全局配置卡片：平台级键与所有环境共用的键；行点击展开编辑。 */
function GlobalConfigCard({ remote, status, globalConfig, onChanged }: {
  remote: Remote
  status: CredentialStatusMap
  globalConfig: GlobalConfigInfo
  onChanged: () => void
}) {
  const rows = globalCredentialViews(MATRIX, status, globalConfig)
  return (
    <div className="dshs-card">
      <div className="dshs-cardTitle">
        全局配置
        <small>不随环境变化；token 仅展示配置状态</small>
      </div>
      <div className="dshs-globalList">
        {rows.map(row => {
          const isPath = row.ref === CODE_BASE_REF
          return (
            <CredentialItem
              key={row.ref}
              remote={remote}
              credentialRef={row.ref}
              info={row.info}
              initialValue={row.value}
              secret={!isPath}
              left={(
                <span className="dshs-globalMain">
                  <span className="dshs-globalLabel">
                    {row.label}
                    <span className="dshs-globalRef">{row.ref}</span>
                  </span>
                  <span className="dshs-legend">{row.description}</span>
                </span>
              )}
              rightExtras={isPath && (
                row.value !== undefined
                  ? <span className="dshs-globalValue">{row.value}</span>
                  : <span className="dshs-legend">未配置</span>
              )}
              onChanged={onChanged}
            />
          )
        })}
      </div>
    </div>
  )
}

function EnvironmentList({ views, onSelect }: {
  views: EnvReadinessView[]
  onSelect: (env: string) => void
}) {
  return (
    <div className="dshs-card">
      <div className="dshs-cardTitle">
        环境列表
        <small>点击环境查看数据源配置和凭据状态</small>
      </div>
      <div className="dshs-envList">
        {views.map(view => (
          <button key={view.env} type="button" className="dshs-envRow" onClick={() => onSelect(view.env)}>
            <span className="dshs-envMain">
              <span className="dshs-envName">{view.env}</span>
              {view.aliases.length > 0 && <span className="dshs-legend">{view.aliases.join(' / ')}</span>}
            </span>
            <span className="dshs-envMeta">
              <Status state={view.ready ? 'ok' : 'miss'}>
                {view.ready ? '凭据就绪' : `缺 ${view.missingRefs.length} 项凭据`}
              </Status>
              <ChevronRightIcon className="dshs-chev" />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function EnvironmentDialog({ remote, view, status, onClose, onChanged }: {
  remote: Remote
  view: EnvReadinessView
  status: CredentialStatusMap
  onClose: () => void
  onChanged: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [tab, setTab] = useState<DialogTab>('greptimedb')
  const row = MATRIX[view.env]!
  const credentialRefs = new Map(legCredentialRefs(row).map(entry => [entry.leg, entry.refs]))
  const generalGroups = [
    { key: 'db', label: '数据库', fields: configFields(row.db ?? {}) },
    { key: 'codeRepository', label: '代码仓库', fields: configFields(row.codeRepository ?? {}) },
  ].filter(group => group.fields.length > 0)
  const activeLeg = tab === 'general' ? undefined : tab
  const activeReadiness = activeLeg === undefined ? undefined : view.legs.find(leg => leg.leg === activeLeg)
  const activeRefs = activeLeg === undefined ? [] : credentialRefs.get(activeLeg) ?? []
  const activeFields = activeLeg === undefined ? [] : configFields(row[activeLeg] ?? {})

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    closeRef.current?.focus()
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onClose])

  /** 垂直 tablist 键盘导航：↑↓ 循环、Home/End 首尾。 */
  const handleNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const current = NAV_ITEMS.findIndex(item => item.key === tab)
    let next: number
    if (event.key === 'ArrowDown') next = (current + 1) % NAV_ITEMS.length
    else if (event.key === 'ArrowUp') next = (current - 1 + NAV_ITEMS.length) % NAV_ITEMS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = NAV_ITEMS.length - 1
    else return
    event.preventDefault()
    const target = NAV_ITEMS[next]!.key
    setTab(target)
    document.getElementById(`dshs-nav-${target}`)?.focus()
  }

  return (
    <div className="dshs-overlay" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="dshs-dialog" role="dialog" aria-modal="true" aria-labelledby="dshs-env-dialog-title">
        <header className="dshs-dialogHeader">
          <div>
            <h2 id="dshs-env-dialog-title" className="dshs-dialogTitle">{view.env}</h2>
            <div className="dshs-dialogMeta">
              {view.aliases.length > 0 && <span className="dshs-legend">别名：{view.aliases.join(' / ')}</span>}
              <Status state={view.ready ? 'ok' : 'miss'}>
                {view.ready ? '凭据全部就绪' : `缺少 ${view.missingRefs.length} 项凭据`}
              </Status>
            </div>
          </div>
          <button ref={closeRef} type="button" className="dshs-btn icon" aria-label="关闭环境详情" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="dshs-dialogMain">
          <nav
            className="dshs-navCol"
            role="tablist"
            aria-orientation="vertical"
            aria-label="数据源"
            onKeyDown={handleNavKeyDown}
          >
            {NAV_ITEMS.map(item => {
              const readiness = item.key === 'general'
                ? undefined
                : view.legs.find(leg => leg.leg === item.key)
              const dotClass = readiness === undefined ? 'neutral' : readiness.ok ? 'ok' : 'miss'
              return (
                <Fragment key={item.key}>
                  {item.key === 'general' && <div className="dshs-navSep" aria-hidden="true" />}
                  <button
                    id={`dshs-nav-${item.key}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.key}
                    aria-controls={`dshs-panel-${item.key}`}
                    tabIndex={tab === item.key ? 0 : -1}
                    className={`dshs-navItem ${tab === item.key ? 'active' : ''}`}
                    onClick={() => setTab(item.key)}
                  >
                    {item.key === 'general'
                      ? <span className="dshs-navSpacer" aria-hidden="true" />
                      : <span className={`dshs-sourceDot ${dotClass}`} aria-hidden="true" />}
                    {item.label}
                  </button>
                </Fragment>
              )
            })}
          </nav>
          <div className="dshs-contentCol">
            {activeLeg === undefined
              ? (
                <section
                  id="dshs-panel-general"
                  className="dshs-sourcePanel"
                  role="tabpanel"
                  aria-labelledby="dshs-nav-general"
                  tabIndex={0}
                >
                  <div className="dshs-panelHeader">
                    通用配置
                    <span className="dshs-legend">数据库与代码仓库等环境级配置</span>
                  </div>
                  {generalGroups.length > 0
                    ? generalGroups.map(group => (
                      <div key={group.key} className="dshs-fieldsGroup">
                        <span className="dshs-refLabel">{group.label}</span>
                        <dl className="dshs-fields">
                          {group.fields.map(field => (
                            <div key={field.key} style={{ display: 'contents' }}>
                              <dt>{field.label}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))
                    : <p className="dshs-hint" style={{ padding: '12px 14px' }}>没有额外配置。</p>}
                </section>
                )
              : (
                <section
                  id={`dshs-panel-${activeLeg}`}
                  className="dshs-sourcePanel"
                  role="tabpanel"
                  aria-labelledby={`dshs-nav-${activeLeg}`}
                  tabIndex={0}
                >
                  <div className="dshs-panelHeader">
                    {LEG_LABELS[activeLeg]}
                    {activeReadiness !== undefined
                      ? <Status state={activeReadiness.ok ? 'ok' : 'miss'}>{activeReadiness.ok ? '就绪' : '未就绪'}</Status>
                      : <span className="dshs-pill">{activeLeg === 'prometheus' ? '随 Grafana 认证' : activeLeg === 'kubernetes' ? '网关免鉴权（只读）' : '无需独立凭据'}</span>}
                    {activeReadiness?.authMode !== undefined && (
                      <span className="dshs-legend">{activeReadiness.authMode === 'token' ? 'Token 认证' : '账密认证'}</span>
                    )}
                  </div>
                  {activeFields.length > 0
                    ? (
                      <dl className="dshs-fields">
                        {activeFields.map(field => (
                          <div key={field.key} style={{ display: 'contents' }}>
                            <dt>{field.label}</dt>
                            <dd>{field.value}</dd>
                          </div>
                        ))}
                      </dl>
                      )
                    : <p className="dshs-hint" style={{ padding: '12px 14px' }}>该数据源没有额外配置。</p>}
                  {activeRefs.length > 0 && (
                    <div className="dshs-refs">
                      <span className="dshs-refLabel">所需凭据（点击行填写）</span>
                      {activeRefs.map(ref => (
                        <CredentialItem
                          key={ref}
                          remote={remote}
                          credentialRef={ref}
                          info={status[ref]}
                          secret
                          left={<span className="dshs-mono">{ref}</span>}
                          onChanged={onChanged}
                        />
                      ))}
                    </div>
                  )}
                </section>
                )}
          </div>
        </div>
        <footer className="dshs-dialogFooter">
          环境矩阵配置由发布包提供，页面只读；凭据保存在本机凭据库，页面只写新值、不回显机密值。
        </footer>
      </section>
    </div>
  )
}

export interface SectionServices {
  remote: Remote
  /** 订阅宿主失效事件（凭据变更 / 连接重置），返回取消函数。 */
  subscribe(invalidate: () => void): () => void
}

interface StatusState {
  status: CredentialStatusMap | undefined
  defaultEnv: DefaultEnvInfo | undefined
  globalConfig: GlobalConfigInfo | undefined
  error: string | undefined
  /** 自增触发重新拉取。 */
  revision: number
}

function SectionImpl({ services }: { services: SectionServices }): JSX.Element {
  const [state, setState] = useState<StatusState>({
    status: undefined,
    defaultEnv: undefined,
    globalConfig: undefined,
    error: undefined,
    revision: 0,
  })
  const [selectedEnv, setSelectedEnv] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [defaultEnvResponse, globalConfigResponse] = await Promise.all([
          services.remote.getDefaultEnv(),
          services.remote.getGlobalConfig(),
        ])
        if (!defaultEnvResponse.ok) throw new Error(defaultEnvResponse.error.message)
        if (!globalConfigResponse.ok) throw new Error(globalConfigResponse.error.message)
        const status = await fetchStatus(services.remote)
        if (!cancelled) {
          setState({
            status,
            defaultEnv: defaultEnvResponse.value,
            globalConfig: globalConfigResponse.value,
            error: undefined,
            revision: 0,
          })
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            status: undefined,
            defaultEnv: undefined,
            globalConfig: undefined,
            error: cause instanceof Error ? cause.message : String(cause),
            revision: 0,
          })
        }
      }
    })()
    return () => { cancelled = true }
  }, [services, state.revision])

  useEffect(() => services.subscribe(() => {
    setState(previous => ({ ...previous, revision: previous.revision + 1 }))
  }), [services])

  styleInject(CSS)

  const readiness = useMemo(
    () => state.status === undefined ? [] : envReadinessViews(MATRIX, state.status),
    [state.status],
  )
  const closeDialog = useCallback(() => setSelectedEnv(undefined), [])
  const refresh = useCallback(() => {
    setState(previous => ({ ...previous, revision: previous.revision + 1 }))
  }, [])
  const selectedView = readiness.find(view => view.env === selectedEnv)

  return (
    <div className="dshs-page">
      <p className="dshs-hint">
        默认环境和凭据为本机配置，可在此查看与修改；环境矩阵配置随发布包提供，仅支持查看。
      </p>
      {state.error !== undefined && <p className="dshs-error">设置状态读取失败：{state.error}</p>}
      {state.status !== undefined && state.defaultEnv !== undefined && state.globalConfig !== undefined && (
        <>
          <DefaultEnvCard
            remote={services.remote}
            info={state.defaultEnv}
            readiness={readiness}
            onChanged={refresh}
          />
          <GlobalConfigCard
            remote={services.remote}
            status={state.status}
            globalConfig={state.globalConfig}
            onChanged={refresh}
          />
          <EnvironmentList views={readiness} onSelect={setSelectedEnv} />
        </>
      )}
      {state.status === undefined && state.error === undefined && <p className="dshs-hint">加载环境状态…</p>}
      {selectedView !== undefined && state.status !== undefined && (
        <EnvironmentDialog
          key={selectedView.env}
          remote={services.remote}
          view={selectedView}
          status={state.status}
          onClose={closeDialog}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

/** 由 apply 闭包创建已接线的 section 组件（remote/订阅不经过模块全局）。 */
export function createSection(services: SectionServices): (props: SettingsSectionOwnerProps) => JSX.Element {
  const component = function SentrEnvironmentCredentialsSection(_props: SettingsSectionOwnerProps) {
    return <SectionImpl services={services} />
  }
  return component
}
