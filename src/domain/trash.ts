// 回收站行上的两种说法（r271）：模板库与作品两个回收站共用，所以放在 domain 里。
// 放在组件文件里会被 fast-refresh 规则拦（组件文件只导出组件），也会让两个页面各写一套。

const pad = (value: number) => String(value).padStart(2, '0')
const DAY_MS = 24 * 60 * 60 * 1000

/** 行上的「删于 MM-DD HH:mm」：时间读不出来就写「未知」，不编一个。 */
export function deletedLabel(at?: string) {
  if (!at) return '删除时间未知'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '删除时间未知'
  return '删于 ' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** 还剩几天清空：到期那天写 0 天，不写负数。 */
export function leftDays(at: string | undefined, days: number) {
  if (!at) return days
  const time = Date.parse(at)
  if (Number.isNaN(time)) return days
  const left = Math.ceil((time + days * DAY_MS - Date.now()) / DAY_MS)
  return Math.max(0, left)
}
