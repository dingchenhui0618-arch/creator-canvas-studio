// 发版后的旧标签页：dist 是整包替换的，旧 index.html 里引用的 lazy chunk 文件名在新包里已经不存在。
// 这时点进那一页会 404，浏览器抛「Failed to fetch dynamically imported module」，页面白掉、只能手动刷新。
// 生产 client-errors 里 11-12 就留下过三条这样的记录（CanvasPage-*、AgentsPage-*、wrench-*）。
//
// 这个文件只放纯判定：该不该自动重载一次、什么时候不该。浏览器那侧怎么接事件在 src/lib/chunkReload.ts。

export const CHUNK_RELOAD_WINDOW_MS = 20000
export const CHUNK_RELOAD_MAX_ATTEMPTS = 2
export const CHUNK_RELOAD_STORAGE_KEY = 'vq.chunk-reload'

export type ChunkReloadState = { at: number; attempts: number }

export type ChunkReloadDecision = {
  reload: boolean
  /** first: 第一次撞上；retry: 同一次发版里的第二次；loop: 连着撞太多次不再重载；offline: 断网不折腾 */
  reason: 'first' | 'retry' | 'loop' | 'offline'
  state: ChunkReloadState | null
}

// 浏览器与打包器报这几种话说的是同一件事：要的那份页面文件取不到了。
const CHUNK_FAILURE_PATTERNS: RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /loading css chunk \S+ failed/i,
  /loading chunk \S+ failed/i,
  /chunkloaderror/i,
]

export function isChunkLoadFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const name = typeof error === 'object' && 'name' in (error as Record<string, unknown>)
    ? String((error as { name?: unknown }).name ?? '')
    : ''
  const message = typeof error === 'object' && 'message' in (error as Record<string, unknown>)
    ? String((error as { message?: unknown }).message ?? '')
    : String(error)
  if (name === 'ChunkLoadError' || name === 'vite:preloadError') return true
  const text = message || name
  return CHUNK_FAILURE_PATTERNS.some((pattern) => pattern.test(text))
}

export function readChunkReloadState(raw: string | null | undefined): ChunkReloadState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ChunkReloadState> | null
    if (!parsed || typeof parsed !== 'object') return null
    const at = Number(parsed.at)
    const attempts = Number(parsed.attempts)
    if (!Number.isFinite(at) || !Number.isFinite(attempts)) return null
    if (at <= 0 || attempts <= 0) return null
    return { at, attempts: Math.min(Math.floor(attempts), CHUNK_RELOAD_MAX_ATTEMPTS + 5) }
  } catch {
    return null
  }
}

// 表记录的是「上一次自动重载发生在什么时候、这一波已经重载过几次」。
// 同一次发版撞两次就够判断了：文件还在（重载就拿到新包）会立刻好；文件真没了（重载也 404）
// 就该停下来把选择交给用户，绝不能在 20 秒里无限刷新。
export function decideChunkReload(input: {
  state: ChunkReloadState | null
  now: number
  online: boolean
}): ChunkReloadDecision {
  const { state, online } = input
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  if (!online) return { reload: false, reason: 'offline', state }
  // 时钟回拨（系统时间被改、或表里是更早一次留下的坏值）按新的一波算，不因为脏数据把用户卡住。
  const sameWave = state !== null && state.at > 0 && now >= state.at && now - state.at <= CHUNK_RELOAD_WINDOW_MS
  if (!sameWave) return { reload: true, reason: 'first', state: { at: now, attempts: 1 } }
  if (state.attempts >= CHUNK_RELOAD_MAX_ATTEMPTS) return { reload: false, reason: 'loop', state }
  return { reload: true, reason: 'retry', state: { at: now, attempts: state.attempts + 1 } }
}

// 给错误卡用：从异常里抠出取不到的那份文件，界面上只显示文件名，不显示完整地址。
export function chunkFailureFile(error: unknown): string {
  const message = typeof error === 'object' && error !== null && 'message' in (error as Record<string, unknown>)
    ? String((error as { message?: unknown }).message ?? '')
    : String(error ?? '')
  const match = message.match(/assets\/[A-Za-z0-9._-]+/i)
  return match ? match[0].slice(0, 120) : ''
}
