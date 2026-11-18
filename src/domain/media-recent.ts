import type { MediaTask } from '../api/media-gen'

// 「最近生成」一页取几条。刷新清单一律按这一页取，不跟着翻页长大：
// 接口单次上限是 24 条，条数跟着翻页长上去会被服务端截断，已经翻出来的旧行就凭空少了。
export const RECENT_PAGE_SIZE = 6

// 没翻过页：整页替换，状态与「还有更早的」都跟着服务端走。
// 翻过页：只把新出现的任务插到最前面、已在清单里的就地更新，
// 已经翻出来的更早行一条不动，hasMore / capped 也留给翻页那边管——
// 否则一次 5 秒刷新就会把「翻到底」又变回「还有更多」，用户以为白翻了。
export function mergeRecentTasks(shown: MediaTask[], incoming: MediaTask[], paged: boolean): MediaTask[] {
  if (!paged) return incoming
  if (!incoming.length) return shown
  const byId = new Map(incoming.map((item) => [item.id, item]))
  const patched = shown.map((item) => byId.get(item.id) ?? item)
  const seen = new Set(shown.map((item) => item.id))
  const fresh = incoming.filter((item) => !seen.has(item.id))
  return fresh.length ? fresh.concat(patched) : patched
}
