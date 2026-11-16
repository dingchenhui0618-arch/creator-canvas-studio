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

import type { DeliveryPerson } from './project'

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

/** 点那一下会落在哪一条：title 里说清，不让人点完才发现 */
export function personTitle(person: DeliveryPerson | null | undefined): string {
  const name = String(person?.name || '').trim()
  if (!name) return ''
  const count = Math.max(0, Math.round(Number(person?.count) || 0))
  const sealed = Math.max(0, Math.round(Number(person?.sealed) || 0))
  const pending = Math.max(0, Math.round(Number(person?.pending) || 0))
  const acked = Math.max(0, Math.round(Number(person?.pendingAcked) || 0))
  const where = '点一下打开他那边最近的那一条交付'
  if (pending) {
    return (
      name +
      '：' +
      count +
      ' 条交付，' +
      pending +
      ' 条还欠着回执' +
      (acked ? '（其中 ' + acked + ' 条他自己点了「收到了」，只差验）' : '') +
      '。' +
      where +
      '。'
    )
  }
  if (sealed === count) return name + '：' + count + ' 条交付，回执都回来了。' + where + '。'
  return name + '：' + count + ' 条交付，其中 ' + sealed + ' 条封过包、回执都回来了。' + where + '。'
}

/** 顶上那句：几个人、几个还欠着；一个人都没有就是空串（调用方不渲染这一块） */
export function peopleLeadText(people: DeliveryPerson[] | null | undefined): string {
  const list = Array.isArray(people) ? people : []
  if (!list.length) return ''
  const pending = list.filter((person) => Number(person.pending) > 0).length
  const head = '按人看：' + list.length + ' 个人'
  return pending ? head + '，其中 ' + pending + ' 个还欠着回执' : head + '，回执都回来了'
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
