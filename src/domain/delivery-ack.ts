// 收包人那一侧的第一句话（v0.9.151）：他点了「收到了」。
//
// 从链接发出去到收据贴回来，中间这一段发件人手上只有「打开过几次」这一个数：
// 打开过 = 也许他只是点了一下；一次没打开 = 也许真没送到。分不清，就只能去问。
// 可答案本来就在收包人手上——他在那一页点一下，发件人就不用猜，也不用再换第四条地址。
//
// 这一下只说「东西到我手上了」，不说「验过了」：验没验以收据为准。
// 也不知道点的人是谁（那一侧没有账号，转发给别人也算一次），所以每一句只说「他点了」，
// 不写成「他收到了」——那是替对方下结论。

import type { DeliveryAck } from './project'

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 点的那一下是几点：'11-15 20:03'；时间读不出来就是空串，不硬编一个。 */
export function deliveryAckAt(ack: DeliveryAck | null | undefined): string {
  const ms = Date.parse(String(ack?.at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/**
 * 作品页档案里那一行：他点过没有、什么时候点的。
 * 没点过就是空串——没发生的事不写成一行字。
 */
export function deliveryAckText(ack: DeliveryAck | null | undefined): string {
  const at = deliveryAckAt(ack)
  if (!at) return ''
  return '他在回执页点了「收到了」· ' + at
}

/**
 * 工作台那一行的开头（v0.9.151）：还没收到收据，但「没送到」这一层已经排除了。
 * 写成「他点了「收到了」，收据还没贴」而不是「他说收到了」——
 * 点的是按钮，不是他打的字；这一行只说发生过的事。
 */
export function deliveryAckLead(ack: DeliveryAck | null | undefined): string {
  return deliveryAckAt(ack) ? '他点了「收到了」，收据还没贴' : ''
}

/**
 * 那一行胶囊的 title：说清「这意味着什么、下一步做什么」。
 * 下一步是等收据、催他验，不是再发一遍地址——地址已经送到、东西也已经到手了。
 */
export function deliveryAckHint(ack: DeliveryAck | null | undefined): string {
  const at = deliveryAckAt(ack)
  if (!at) return ''
  return (
    '他在回执页上点了「收到了」' +
    at +
    '：东西到他手上了，验还没完——收据回来之前别当没送到，也别再换地址。' +
    '到点还没动静，用「复制提醒」催他验，不用重发链接'
  )
}

/**
 * 清单顶上那句：还没回来的几份里，有几份是他自己说了收到的。
 * 这一句是把「可能没送到」那一堆拆开——那几份已经不用再问了。
 */
export function deliveryAckedText(count: number): string {
  const n = Math.max(0, Math.round(Number(count) || 0))
  if (!n) return ''
  return '其中 ' + n + ' 次他自己点了「收到了」：东西到手了，只差验完把收据贴回来。'
}
