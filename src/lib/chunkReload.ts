// 发版后旧标签页的自救：Vite 的动态 import 失败会派发 vite:preloadError，拦住它就能原地重载一次。
// 判定全在 src/domain/chunk-reload.ts，这里只负责接事件、读写 sessionStorage、真的 reload。
import {
  CHUNK_RELOAD_STORAGE_KEY,
  decideChunkReload,
  isChunkLoadFailure,
  readChunkReloadState,
} from '../domain/chunk-reload'

function readStore(win: Window): string | null {
  try {
    return win.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)
  } catch {
    // 隐私模式、被禁用，读不到就当没有记录：宁可重载一次，也不要让用户对着白屏。
    return null
  }
}

function writeStore(win: Window, value: string): void {
  try {
    win.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, value)
  } catch {
    // 写不进去就退化成「每次都能重载」：同一波最多重载两次由内存里的 handled 兜住。
  }
}

export function installChunkReloadGuard(win: Window = window): void {
  let handled = false

  const handle = (error: unknown): boolean => {
    if (handled || !isChunkLoadFailure(error)) return false
    const now = Date.now()
    const decision = decideChunkReload({
      state: readChunkReloadState(readStore(win)),
      now,
      online: win.navigator.onLine !== false,
    })
    if (!decision.reload || !decision.state) return false
    handled = true
    writeStore(win, JSON.stringify(decision.state))
    win.location.reload()
    return true
  }

  // Vite 5.1+ 在动态 import 失败时派发；preventDefault 之后错误不再往上抛，页面不会走到错误边界。
  win.addEventListener('vite:preloadError', (event) => {
    const payload = (event as Event & { payload?: unknown }).payload
    if (handle(payload)) event.preventDefault()
  })

  // 兜底：不走 Vite preload 的模块失败（入口、CSS preload 等）只会以 rejection 的形式出现。
  win.addEventListener('unhandledrejection', (event) => {
    if (handle((event as PromiseRejectionEvent).reason)) event.preventDefault()
  })
}
