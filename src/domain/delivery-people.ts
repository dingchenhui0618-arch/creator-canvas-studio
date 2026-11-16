// 按人看（v0.9.154）：同一个收件人名下有几条交付、几条还欠着回执。
//
// r152 让每条交付写清「给谁」，r153 让他回的那句话有地方落。可工作台那一列一行一行排下来，
// 问的都是「哪一条还没回来」；交给同一个人三四条时，真正想问的是「王老师那边还欠几份」。
// 这一堆数回答那一句：谁还欠着、欠几条、点一下落在哪一条上。
//
// 边界：
//  - 只数写了收件人的记录：没写的另算一个数，不猜是谁，也不混进任何一个人名下；
//  - 「欠着」只算封过包、还没收到收据的：没包的老交付谈不上回执，对上的也不再催；
//  - 不按人对「送达」下结论：这里只说收据回来了没有，不说他人怎么样。
//
// v0.9.155：欠着几条还不够急——同样欠两条，一个是昨天刚发的、一个已经拖了六天。
// 所以每一枚再加两件事：欠着的那几条里最早一条等了几天、这个人名下催过几次。

import type { DeliveryPerson } from './project'
import { deliveryWaitDays, monthDayText } from './delivery-wait.ts'

/** 一个人名下几条交付、几条还欠着：行上按钮里那一小段 */
export function personSummary(person: DeliveryPerson | null | undefined): string {
  const count = Math.max(0, Math.round(Number(person?.count) || 0))
  if (!count) return ''
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  if (pending) return count + ' 条 · ' + pending + ' 条还欠着'
  const sealed = Math.max(0, Math.round(Number(person?.sealed) || 0))
  if (!sealed) return count + ' 条 · 没有封存包'
  return count + ' 条 · 回执都回来了'
}

/**
 * 欠着的那几条里最早一条等了几天：没有欠着的、或者那几条都没记下时间就是 null。
 * 时间读不出来时宁可不写天数，也不拿今天减一个空值算出「0 天」。
 */
function oldestPendingDays(person: DeliveryPerson | null | undefined, now: number | Date): number | null {
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  if (!pending) return null
  return deliveryWaitDays(String(person?.oldestPendingAt || ''), now)
}

/** 这一枚按钮上那句「等了多久」：只看最早那一条，不说平均，也不预测他什么时候验 */
export function personWaitText(person: DeliveryPerson | null | undefined, now: number | Date = Date.now()): string {
  const days = oldestPendingDays(person, now)
  if (days === null) return ''
  return days <= 0 ? '最早一条今天发出' : '最早一条 ' + days + ' 天没回'
}

/** 催过没有：欠着的人才谈得上催，一次都没催过就写「还没催过」——不写成空白 */
export function personNaggedText(person: DeliveryPerson | null | undefined): string {
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  if (!pending) return ''
  const count = Math.max(0, Math.round(Number(person?.reminded?.count) || 0))
  if (!count) return '还没催过'
  const at = monthDayText(String(person?.reminded?.at || ''))
  return '催过 ' + count + ' 次' + (at ? '，最近 ' + at : '')
}

/** 点那一下会落在哪一条：title 里说清，不让人点完才发现 */
export function personTitle(person: DeliveryPerson | null | undefined, now: number | Date = Date.now()): string {
  const name = String(person?.name || '').trim()
  if (!name) return ''
  const count = Math.max(0, Math.round(Number(person?.count) || 0))
  const sealed = Math.max(0, Math.round(Number(person?.sealed) || 0))
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  const acked = Math.max(0, Math.round(Number(person?.pendingAcked) || 0))
  const where = '点一下打开他那边最近的那一条交付'
  if (pending) {
    // 等得最久的是哪一条、催过几次（v0.9.155）：光说「欠 2 条」分不出「昨天刚发」和「拖了六天」
    const days = oldestPendingDays(person, now)
    const wait =
      days === null
        ? ''
        : days <= 0
          ? '最早的一条是今天发出的。'
          : '最早的一条是 ' + monthDayText(String(person?.oldestPendingAt || '')) + ' 发出的，已经 ' + days + ' 天没回。'
    return (
      name +
      '：' +
      count +
      ' 条交付，' +
      pending +
      ' 条还欠着回执' +
      (acked ? '（其中 ' + acked + ' 条他自己点了「收到了」，只差验）' : '') +
      '。' +
      wait +
      personNaggedText(person) +
      '。' +
      where +
      '。'
    )
  }
  if (sealed === count) return name + '：' + count + ' 条交付，回执都回来了。' + where + '。'
  return name + '：' + count + ' 条交付，其中 ' + sealed + ' 条封过包、回执都回来了。' + where + '。'
}

/** 顶上那句：几个人、几个还欠着；一个人都没有就是空串（调用方不渲染这一块） */
export function peopleLeadText(people: DeliveryPerson[] | null | undefined, now: number | Date = Date.now()): string {
  const list = Array.isArray(people) ? people : []
  if (!list.length) return ''
  const pending = list.filter((person) => Number(person.pending) > 0).length
  const head = '按人看：' + list.length + ' 个人'
  if (!pending) return head + '，回执都回来了'
  // 等得最久的那一份等了几天（v0.9.155）：天数说得出才加这一句，今天刚发的不算「等了」
  let longest = 0
  for (const person of list) {
    const days = oldestPendingDays(person, now)
    if (days !== null && days > longest) longest = days
  }
  return head + '，其中 ' + pending + ' 个还欠着回执' + (longest > 0 ? '；最久的等了 ' + longest + ' 天' : '')
}

/** 没写收件人的那些：单独一个数，不混进任何人名下 */
export function unlabeledText(count: number | null | undefined): string {
  const n = Math.max(0, Math.round(Number(count) || 0))
  return n ? '另有 ' + n + ' 条没写收件人' : ''
}

/** 一个人名下欠着的那几条里，他自己说了「收到了」的有几条：档案里那一行用得到这一句 */
export function personAckedNote(person: DeliveryPerson | null | undefined): string {
  const acked = Math.max(0, Math.round(Number(person?.pendingAcked) || 0))
  return acked ? '其中 ' + acked + ' 条他自己点了「收到了」' : ''
}
