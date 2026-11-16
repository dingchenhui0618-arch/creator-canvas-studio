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
//
// v0.9.156：催过之后到底有没有回音。「催过 2 次，最近 11-12」只说发过话，
// 没说那句话有没有用；这里补上「催完第 2 天回了」/「催完 4 天没动静」，
// 说了话还没动静的，就该换个渠道，而不是再催一遍。

import type { DeliveryPerson } from './project'
import { REMIND_LATE_DAYS, deliveryWaitDays, monthDayText } from './delivery-wait.ts'

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

/**
 * 催过没有：欠着的人一次都没催过就写「还没催过」——不写成空白。
 * 回执都回来了、但确实催过的人也要说（v0.9.156）：「催完第几天回的」得先有「催过几次」。
 */
export function personNaggedText(person: DeliveryPerson | null | undefined): string {
  const count = Math.max(0, Math.round(Number(person?.reminded?.count) || 0))
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  if (!count) return pending ? '还没催过' : ''
  const at = monthDayText(String(person?.reminded?.at || ''))
  return '催过 ' + count + ' 次' + (at ? '，最近 ' + at : '')
}

const DAY_MS = 86400000

/** 两个时刻之间差几天（整天，向下取整）；有一个读不出来就是 null。 */
function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(String(from || ''))
  const end = Date.parse(String(to || ''))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, Math.floor((end - start) / DAY_MS))
}

/**
 * 催完之后回了没有（v0.9.156）：最近一次催收之后的第一条回执算「回了」。
 * 只说先后和天数——他也许是碰巧有空才验的，这里不下「催一下管用」的结论。
 * 回执没回来、现在也不欠着什么，就什么都不说：没有可催的事，不硬凑一句。
 */
export function personNagOutText(person: DeliveryPerson | null | undefined, now: number | Date = Date.now()): string {
  const count = Math.max(0, Math.round(Number(person?.reminded?.count) || 0))
  if (!count) return ''
  const nagAt = String(person?.reminded?.at || '')
  const replyAt = String(person?.reminded?.replyAt || '')
  if (replyAt) {
    const days = daysBetween(nagAt, replyAt)
    if (days === null) return ''
    return days <= 0 ? '催完当天回了' : '催完第 ' + days + ' 天回了'
  }
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  if (!pending) return ''
  const days = deliveryWaitDays(nagAt, now)
  if (days === null) return ''
  return days <= 0 ? '今天刚催过' : '催完 ' + days + ' 天没动静'
}

/**
 * title 里那一整句：催过几次、最近哪天、催完回了没有；
 * 催过三天以上还没动静，就提一句换个渠道——再催一遍多半还是一样。
 */
function nagSentence(person: DeliveryPerson | null | undefined, now: number | Date): string {
  const nagged = personNaggedText(person)
  if (!nagged) return ''
  const out = personNagOutText(person, now)
  if (!out) return nagged + '。'
  const replyAt = String(person?.reminded?.replyAt || '')
  if (replyAt) return nagged + '，' + out + '（' + monthDayText(replyAt) + ' 的回执）。'
  const days = deliveryWaitDays(String(person?.reminded?.at || ''), now)
  const advice = days !== null && days >= REMIND_LATE_DAYS ? '，换个渠道问一句' : ''
  return nagged + '，' + out + advice + '。'
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
  // 催完之后回了没有（v0.9.156）：回执都回来了的人也说一句——那句「催完第 2 天回了」是他的实绩
  const nag = nagSentence(person, now)
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
      nag +
      where +
      '。'
    )
  }
  const tail = sealed === count ? '回执都回来了。' : '其中 ' + sealed + ' 条封过包、回执都回来了。'
  return name + '：' + count + ' 条交付，' + tail + nag + where + '。'
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
