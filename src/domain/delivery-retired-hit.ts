// 换掉的那条旧地址还被点着（v0.9.149）。
//
// v0.9.148 让旧地址自己会说「已经换成新的了」，收包人那一侧不再糊涂；
// 但发件人那一侧还看不见这件事：他换完地址，新地址的打开次数从零开始，
// 「新地址 0 次打开」于是有两种完全不同的原因——没送到，或者送到了没理。
// 旧的这条还在被点，就是前一种：他手上留着的还是旧的那条。发件人再不知道这一句，
// 最自然的反应是再换一条新地址，于是三条地址发进同一个黑洞。
//
// 边界：
//  - 只说「这条地址被点过几次」，不说「他点过」——可能是他，也可能是转发出去的另一台机器；
//  - 不猜原因、不报身份：这一侧没有账号也没有 IP，多写一个字都是编的；
//  - 点一次不算「打开过」：打开的是一句说明，不是那份包（与 v0.9.148 同一口径）。

/** 与流水那一行同一份输入：次数与最近一次。 */
export type DeliveryRetiredHits = { count?: number; at?: string } | null | undefined

/** 那一行上的一句话：旧地址还被点过几次。一次都没被点过就是空串。 */
export function deliveryRetiredHitText(hits: DeliveryRetiredHits): string {
  const count = Math.max(0, Math.round(Number(hits?.count) || 0))
  return count ? '旧地址还被点过 ' + count + ' 次' : ''
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/** 最近一次是哪天几点：按浏览器时区写——记录里的是 UTC，看的人要的是本地时间。 */
function monthDayTime(at: string): string {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return (
    padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate()) + ' ' + padTwo(date.getHours()) + ':' + padTwo(date.getMinutes())
  )
}

/**
 * 胶囊的 title：说清这件事意味着什么、下一步该做什么。
 * 不写「他打不开」「他没收到」——只知道这条地址被点过，不知道是谁、为什么。
 */
export function deliveryRetiredHitHint(hits: DeliveryRetiredHits): string {
  const count = Math.max(0, Math.round(Number(hits?.count) || 0))
  if (!count) return ''
  const when = monthDayTime(String(hits?.at || ''))
  return (
    '换掉的那条地址' +
    (when ? ' ' + when + ' 还有人点' : '还有人点') +
    '（' + count + ' 次）：他手上可能还是旧的那条，把现在这条再发一次，或者直接问他一句；别再换地址了'
  )
}
