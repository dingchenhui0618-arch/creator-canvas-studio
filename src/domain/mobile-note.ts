// 窄屏那条「这是一个桌面工作台」提示（r224）：点过 × 就不再出现，按浏览器记一次。
// 一句话边界的价值在于「第一次看见」，每页都顶一条 60px 只是噪音；
// 但也不能默认藏起来——第一次进来看的人仍然要知道手机上能做什么、不能做什么。
// 读写都走注入的 store：Node 里能拿假对象测，localStorage 不可用（隐私模式）时不上抛。
export const MOBILE_NOTE_KEY = 'vq_mobile_note_seen'

export type FlagStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 这条提示该不该显示：没记过（或读不出）就显示，记过 1 就藏。 */
export function mobileNoteVisible(store: FlagStore | null): boolean {
  if (!store) return true
  try {
    return store.getItem(MOBILE_NOTE_KEY) !== '1'
  } catch {
    return true
  }
}

/** 点 × 之后调用：写进去返回 true；写不进去返回 false，由调用方决定下次还显示。 */
export function dismissMobileNote(store: FlagStore | null): boolean {
  if (!store) return false
  try {
    store.setItem(MOBILE_NOTE_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** 浏览器里拿 localStorage；隐私模式 / 无 window（Node、桌面壳启动早期）时返回 null。 */
export function browserFlagStore(): FlagStore | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}
