// 回执链接的两句话：这条地址被打开过没有（v0.9.145）。
//
// 一份包发出去几天没回音，要分的两件事是「他根本没点开这条链接」和
// 「他点开了，收据还没贴回来」——前者该先把链接再发一次，后者该催他验。
// 能记下来的只有「这条地址被点开过几次」，不知道是谁打开的，
// 所以这里的每一句都只说链接，不说人：「打开过 2 次」，不写「他看过了」。

import type { DeliveryVisits } from './project'

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 打开过几次：坏值当 0，不把半个数字写到界面上。 */
export function deliveryOpenCount(visits: DeliveryVisits | null | undefined): number {
  return Math.max(0, Math.round(Number(visits?.opens) || 0))
}

/** 最近一次打开：'11-14 20:12'；时间读不出来就是空串，不硬编一个。 */
export function deliveryOpenAt(visits: DeliveryVisits | null | undefined): string {
  const ms = Date.parse(String(visits?.lastAt || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/**
 * 工作台那一行上的短话：「链接还没打开」/「链接打开 2 次」。
 * 不知道（没有这一项，或者链接发出时还没开始记）就是空串——宁可少一句，不编一句。
 */
export function deliveryOpenShort(visits: DeliveryVisits | null | undefined): string {
  if (!visits) return ''
  const count = deliveryOpenCount(visits)
  return count ? '链接打开 ' + count + ' 次' : '链接还没打开'
}

/** 作品页档案里那一行：说全「几次、最近一次什么时候」。 */
export function deliveryOpenDetail(visits: DeliveryVisits | null | undefined): string {
  if (!visits) return ''
  const count = deliveryOpenCount(visits)
  if (!count) return '回执链接发出后还没被打开过'
  const at = deliveryOpenAt(visits)
  return '回执链接打开过 ' + count + ' 次' + (at ? ' · 最近 ' + at : '')
}

/**
 * 那一行胶囊的 title：说清「这意味着下一步做什么」。
 * 打开过 = 链接发到了，等他贴收据；一次都没打开 = 多半没送到，先把链接再发一次。
 */
export function deliveryOpenHint(visits: DeliveryVisits | null | undefined): string {
  if (!visits) return ''
  const count = deliveryOpenCount(visits)
  if (!count) return '回执链接发出去还没被打开过：可能没送到，先把链接再发他一次'
  const at = deliveryOpenAt(visits)
  return '回执链接打开过 ' + count + ' 次' + (at ? '，最近 ' + at : '') + '：链接是送到了，等他贴回收据'
}

/**
 * 清单顶上那句：还没回来的几份里，有几份连链接都没人打开。
 * 「可能没送到」是能说得出口的猜测——也可能被聊天软件的预览抓取过，所以不写成「他没收到」。
 */
export function deliveryUnopenedText(count: number): string {
  const n = Math.max(0, Math.round(Number(count) || 0))
  if (!n) return ''
  return '其中 ' + n + ' 次回执链接还没被打开过：可能没送到，先再发一次。'
}
