// 前端异常上报：浏览器里炸了的东西送到 /api/client-errors，后台「系统」页直接能看到。
//
// 三条自保规则：
//   1. 一次页面加载最多报 8 条，同一条 30 秒内只报一次——坏掉的页面不该把接口打满；
//   2. 上报失败一律吞掉：上报本身不能变成新的异常源；
//   3. 只送 message / stack / 当前 hash / 版本 / UA，不送 cookie、表单内容或任何用户输入。
import packageJsonRaw from '../../package.json?raw'

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'react' | 'resource'

const ENDPOINT = '/api/client-errors'
const MAX_PER_PAGE = 8
const DEDUPE_MS = 30_000
const VERSION = (JSON.parse(packageJsonRaw) as { version?: string }).version ?? ''

let sent = 0
const seen = new Map<string, number>()

function currentPage(): string {
  // hash 路由就是当前看的页面；分享链接里的 token 由服务端再抹一遍
  return (window.location.hash || window.location.pathname || '/').slice(0, 160)
}

function post(kind: ClientErrorKind, message: string, stack = ''): void {
  try {
    const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!text || sent >= MAX_PER_PAGE) return
    const key = kind + '|' + text
    const now = Date.now()
    if (now - (seen.get(key) ?? 0) < DEDUPE_MS) return
    seen.set(key, now)
    sent += 1
    const body = JSON.stringify({
      kind,
      message: text,
      stack: String(stack || '').slice(0, 1200),
      page: currentPage(),
      version: VERSION,
      userAgent: navigator.userAgent,
    })
    // sendBeacon：页面正在崩、马上要卸载时也能发出去
    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
      return
    }
    void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {})
  } catch {
    // 上报是尽力而为：这里再抛一次就成了新的异常
  }
}

/** 给错误边界用：React 渲染期抛错不会走 window.onerror。 */
export function reportReactError(error: Error, componentStack?: string | null): void {
  const message = error?.message ? error.name + ': ' + error.message : String(error)
  const stack = [error?.stack || '', componentStack ? '\n组件栈：\n' + componentStack : ''].join('')
  post('react', message, stack)
}

let installed = false

/** 装一次就够：脚本错误、未处理的 Promise、资源加载失败都挂上。 */
export function installClientErrorReporting(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  // 捕获阶段才拿得到图片/脚本的资源错误（它们不冒泡）
  window.addEventListener(
    'error',
    (event: Event) => {
      if (event instanceof ErrorEvent) {
        const error = event.error as Error | undefined
        const where = event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : ''
        post('error', error?.message || event.message || '未知脚本错误', [where, error?.stack || ''].join('\n'))
        return
      }
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null
      const tag = target?.tagName?.toLowerCase()
      if (!tag || tag === 'body' || tag === 'html') return
      const url = target?.src || target?.href || ''
      if (!url) return
      post('resource', '资源加载失败（' + tag + '）：' + url.slice(0, 160))
    },
    true,
  )

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string; name?: string; stack?: string } | string | undefined
    if (reason && typeof reason === 'object') {
      post('unhandledrejection', (reason.name ? reason.name + ': ' : '') + (reason.message || String(reason)), reason.stack || '')
      return
    }
    post('unhandledrejection', String(reason ?? 'Promise 被拒绝但没有原因'))
  })
}
