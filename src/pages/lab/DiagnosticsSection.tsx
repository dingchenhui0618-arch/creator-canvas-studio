import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Monitor, Package, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import packageRaw from '../../../package.json?raw'
import { EDITION_BY_ID, EDITION_STORAGE_KEY } from '../../editions'
import { clearConsoleEntries, useConsoleCapture } from './consoleStore'
import { formatClock, formatMs, probeJson } from './probe'
import type { ProbeResult } from './probe'

const LOCAL_VERSION = (JSON.parse(packageRaw) as { version?: string }).version ?? '0.0.0'

type ServiceProbe = {
  id: string
  label: string
  url: string
  ok: boolean
  ms: number
  detail: string
  at: string
}

async function probeService(id: string, label: string, url: string, opaque: boolean, timeoutMs = 3000): Promise<ServiceProbe> {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      mode: opaque ? 'no-cors' : 'cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return {
      id,
      label,
      url,
      ok: true,
      ms: Math.round(performance.now() - startedAt),
      detail: opaque ? '可达（no-cors，未读取状态码）' : 'HTTP ' + response.status,
      at: new Date().toISOString(),
    }
  } catch (error) {
    return {
      id,
      label,
      url,
      ok: false,
      ms: Math.round(performance.now() - startedAt),
      detail:
        error instanceof DOMException && error.name === 'AbortError'
          ? '超时（>' + timeoutMs + 'ms）'
          : String((error as Error)?.message || error),
      at: new Date().toISOString(),
    }
  } finally {
    window.clearTimeout(timer)
  }
}

function readBrowserInfo() {
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: Array.isArray(navigator.languages) ? navigator.languages.join(', ') : '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: window.innerWidth + ' × ' + window.innerHeight,
    screen: window.screen.width + ' × ' + window.screen.height,
    devicePixelRatio: window.devicePixelRatio,
    platform: navigator.platform || '—',
    cookieEnabled: navigator.cookieEnabled,
  }
}

function downloadJson(name: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

export function DiagnosticsSection() {
  const logs = useConsoleCapture()
  const browser = useMemo(() => readBrowserInfo(), [])
  // 这个页面只在 lab 形态下渲染，当前形态以页面为准；localStorage 的值单独展示。
  const edition = EDITION_BY_ID.lab
  const editionId = edition.id
  const storedEdition = (() => {
    try {
      return window.localStorage.getItem(EDITION_STORAGE_KEY)
    } catch {
      return null
    }
  })()

  const [version, setVersion] = useState<ProbeResult | null>(null)
  const [services, setServices] = useState<ServiceProbe[]>([])
  const [checking, setChecking] = useState(false)
  const [exportedAt, setExportedAt] = useState('')
  const [exportNote, setExportNote] = useState('')

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      void probeJson('/api/version').then((result) => {
        if (alive) setVersion(result)
      })
    }, 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])

  const checkServices = useCallback(async () => {
    setChecking(true)
    const next = await Promise.all([
      probeService('api', 'API 服务', 'http://127.0.0.1:8787/api/health', false),
      probeService('vite', 'Vite 开发服', 'http://127.0.0.1:5191/', true),
    ])
    setServices(next)
    setChecking(false)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkServices()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [checkServices])

  const remoteVersion =
    version && version.ok && version.data && typeof version.data === 'object'
      ? (version.data as { version?: unknown }).version
      : undefined
  const versionMismatch = typeof remoteVersion === 'string' && remoteVersion !== LOCAL_VERSION

  const exportDiagnostics = () => {
    const now = new Date().toISOString()
    downloadJson('visionqa-diagnostics-' + now.replace(/[:.]/g, '-') + '.json', {
      exportedAt: now,
      page: 'lab/diagnostics',
      edition: {
        id: editionId,
        label: edition.label,
        mono: edition.mono,
        storageKey: EDITION_STORAGE_KEY,
        storedValue: storedEdition,
      },
      version: {
        local: LOCAL_VERSION,
        remote: version?.data ?? null,
        remoteStatus: version?.status ?? 0,
        remoteMs: version?.ms ?? null,
        remoteError: version?.error ?? '',
      },
      browser,
      console: logs,
      services,
    })
    setExportedAt(now)
    setExportNote('已下载 ' + logs.length + ' 条 console 记录')
  }

  return (
    <div className="lab-stack">
      <div className="lab-toolbar">
        <div className="lab-toolbar-copy">
          <span className="lab-mono">DIAGNOSTICS SNAPSHOT</span>
          <span className="lab-dim">版本、浏览器、本地服务与控制台记录都来自当前会话；导出为本地 JSON 文件。</span>
        </div>
        <div className="lab-toolbar-actions">
          {exportedAt && <span className="lab-mono">最近导出：{formatClock(exportedAt)}</span>}
          <button type="button" className="lab-btn lab-btn--ink" onClick={exportDiagnostics}>
            <Download size={13} />
            导出诊断 JSON
          </button>
        </div>
      </div>

      <div className="lab-grid lab-grid--diag3">
        <section className="lab-panel lab-panel--tight">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">VERSION</span>
              <h2>版本</h2>
            </div>
            <Package size={14} className="lab-dim" />
          </div>
          <div className="lab-kv">
            <div>
              <span>本地构建</span>
              <strong className="lab-mono">v{LOCAL_VERSION}</strong>
            </div>
            <div>
              <span>服务端</span>
              <strong className="lab-mono">{remoteVersion ? 'v' + String(remoteVersion) : version ? '读取失败' : '读取中…'}</strong>
            </div>
            <div>
              <span>接口状态</span>
              <span className={'lab-status ' + (version ? (version.ok ? 'lab-status--ok' : 'lab-status--bad') : 'lab-status--idle')}>
                <i aria-hidden="true" />
                {version ? version.status || 'ERR' : '等待'}
              </span>
            </div>
            <div>
              <span>耗时</span>
              <strong className="lab-mono">{version ? formatMs(version.ms) : '—'}</strong>
            </div>
            <div>
              <span>服务启动</span>
              <strong className="lab-mono">
                {version?.ok && version.data && typeof version.data === 'object'
                  ? formatClock(String((version.data as { startedAt?: unknown }).startedAt ?? ''))
                  : '—'}
              </strong>
            </div>
          </div>
          {version && !version.ok && (
            <div className="lab-alert lab-alert--bad">
              <span>/api/version {version.status || '失败'}：{version.error || '没有返回数据'}</span>
            </div>
          )}
          {versionMismatch && (
            <p className="lab-inline-note lab-warn">本地 bundle 与服务端 package.json 版本不一致，页面可能是旧的。</p>
          )}
        </section>

        <section className="lab-panel lab-panel--tight">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">BROWSER</span>
              <h2>浏览器</h2>
            </div>
            <Monitor size={14} className="lab-dim" />
          </div>
          <div className="lab-kv lab-kv--browser">
            <div>
              <span>视口 / 屏幕</span>
              <strong className="lab-mono">
                {browser.viewport} / {browser.screen} @{browser.devicePixelRatio}x
              </strong>
            </div>
            <div>
              <span>时区 / 语言</span>
              <strong className="lab-mono">
                {browser.timeZone} · {browser.language}
              </strong>
            </div>
            <div>
              <span>平台</span>
              <strong className="lab-mono">{browser.platform}</strong>
            </div>
            <div className="lab-kv-wide">
              <span>User-Agent</span>
              <code className="lab-ua">{browser.userAgent}</code>
            </div>
          </div>
        </section>

        <section className="lab-panel lab-panel--tight">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">EDITION</span>
              <h2>当前形态</h2>
            </div>
            <span className="lab-chip">{edition.mono}</span>
          </div>
          <div className="lab-kv">
            <div>
              <span>Edition</span>
              <strong>
                {edition.label} <span className="lab-mono">/ {edition.id}</span>
              </strong>
            </div>
            <div>
              <span>存储键</span>
              <strong className="lab-mono">{EDITION_STORAGE_KEY}</strong>
            </div>
            <div>
              <span>当前值</span>
              <strong className="lab-mono">{storedEdition ?? '未写入'}</strong>
            </div>
            <div>
              <span>读取方式</span>
              <span className="lab-dim">localStorage，切换形态后生效</span>
            </div>
          </div>
        </section>
      </div>

      <div className="lab-grid lab-grid--diag">
        <section className="lab-panel">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">LOCAL SERVICES</span>
              <h2>本地服务</h2>
            </div>
            <button type="button" className="lab-btn lab-btn--small" onClick={() => void checkServices()} disabled={checking}>
              <RefreshCw size={12} className={checking ? 'lab-spin' : undefined} />
              重测
            </button>
          </div>
          <div className="lab-services">
            {services.map((service) => (
              <div className={'lab-service' + (service.ok ? '' : ' is-down')} key={service.id}>
                <span className={'lab-dot ' + (service.ok ? 'lab-dot--ok' : 'lab-dot--bad')} aria-hidden="true" />
                <div>
                  <strong>{service.label}</strong>
                  <span className="lab-mono">{service.url}</span>
                  <em>{service.detail}</em>
                </div>
                <span className="lab-mono">{formatMs(service.ms)}</span>
              </div>
            ))}
            {!services.length && <p className="lab-dim">正在探测 8787 / 5191…</p>}
          </div>
          <p className="lab-inline-note">
            8787 通过 CORS 读取真实状态码；5191 用 no-cors 只判断「能不能连上」，这里不读取状态码。
          </p>
        </section>

        <section className="lab-panel lab-panel--console">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">CONSOLE BUFFER</span>
              <h2>最近 console.error / warn</h2>
            </div>
            <div className="lab-panel-actions">
              <span className="lab-mono">{logs.length}/20</span>
              <button type="button" className="lab-btn lab-btn--small" onClick={clearConsoleEntries} disabled={!logs.length}>
                <Trash2 size={12} />
                清空
              </button>
            </div>
          </div>
          <div className="lab-console" role="log" aria-live="polite">
            {logs.map((entry) => (
              <div className={'lab-log lab-log--' + entry.level} key={entry.id}>
                <span className="lab-log-time">{new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className={'lab-log-level ' + (entry.level === 'error' ? 'lab-bad' : 'lab-warn')}>
                  {entry.level === 'error' ? 'ERR' : 'WARN'}
                </span>
                <span className="lab-log-text">{entry.text}</span>
              </div>
            ))}
            {!logs.length && (
              <div className="lab-console-empty">
                <Terminal size={16} />
                <span>从本页挂载开始收集 console.error / console.warn；目前没有记录。</span>
              </div>
            )}
          </div>
          <p className="lab-inline-note">
            只保留最近 20 条，不写服务端；页面卸载时恢复原始 console。{exportNote ? ' ' + exportNote : ''}
          </p>
        </section>
      </div>

      <p className="lab-footnote">
        <Terminal size={12} />
        <span>
          导出文件包含：版本响应对照、浏览器信息、当前 edition、8787 / 5191 探测结果、最近 20 条 console
          记录；不包含截图、账号或模型 Key。
        </span>
      </p>
    </div>
  )
}