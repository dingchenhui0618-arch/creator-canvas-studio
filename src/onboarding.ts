// 引导页的「看过一次」标记：按账号存，换账号各算各的。
// localStorage 不可用（隐私模式）时返回空串，调用方就不再读写。
export function welcomeSeenKey(userId: string): string {
  const id = String(userId || '').trim()
  if (!id) return ''
  try {
    // 先探一次写权限：隐私模式下 getItem 正常但 setItem 会抛
    window.localStorage.setItem('vq_probe', '1')
    window.localStorage.removeItem('vq_probe')
  } catch {
    return ''
  }
  return 'vq_welcome_seen:' + id
}
