// 交出去的那一份，等了多久（v0.9.144）。
//
// 为什么要有它：回执清单只说了「还没收到回执」，没说「发出三天了」。收包人一直没验，
// 要么是还没空、要么是忘了——这件事只有天数说得清。所以这里只做三件纯计算：
// 交付到今天过了几天、到了该提一句的时候没有、以及把提醒写成一段能直接发出去的话。
//
// 边界：
//  - 天数按整天算（floor），当天发出写「今天发出」，不写成「发出 0 天」；
//  - 交付时间读不出来就说不出天数，不拿作品更新时间之类的字段冒充；
//  - 「该催了」只按天数算，不猜对方为什么没验，也不预测他什么时候会验；
//  - 提醒那段话只写档案里记着的事实（哪一版、哪个包、多少字节、哪天发的、链接），
//    不编原因、不承诺赔偿，也不替发件人答应重发。

import { recipientGreeting } from './delivery-recipient.ts'

/** 发出几天算「该提一句了」：一份包两三天内验完是常态，过了第三天提一句不算催命。 */
export const REMIND_LATE_DAYS = 3

const DAY_MS = 86400000

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 交付到现在的天数；时间读不出来就是 null（调用方据此不写天数）。 */
export function deliveryWaitDays(at: string, now: number | Date = Date.now()): number | null {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return null
  const current = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(current)) return null
  return Math.max(0, Math.floor((current - ms) / DAY_MS))
}

/** 那一行上的「等了多久」：今天发出的说今天，之后按整天数。读不出时间就是空串。 */
export function deliveryWaitText(at: string, now: number | Date = Date.now()): string {
  const days = deliveryWaitDays(at, now)
  if (days === null) return ''
  return days <= 0 ? '今天发出' : '发出 ' + days + ' 天'
}

/** 该提一句了没有：到了第三天以上才说，时间读不出来就不说。 */
export function deliveryWaitLate(at: string, now: number | Date = Date.now()): boolean {
  const days = deliveryWaitDays(at, now)
  return days !== null && days >= REMIND_LATE_DAYS
}

/**
 * 催过几天还没动静（v0.9.157）：从最近一次催收算起，与「发出超过三天」同一个阈值。
 * 三天以内再等等，过了第三天，再发一遍一样的话多半还是没动静。
 * 时间读不出来就不说「没动静」——不知道的事不猜成「他没理你」。
 */
export function deliveryNagLate(at: string, now: number | Date = Date.now()): boolean {
  const days = deliveryWaitDays(at, now)
  return days !== null && days >= REMIND_LATE_DAYS
}

/** 清单顶上那句：还没回来的几份里，有几份已经超过三天。没有就返回空串。 */
export function deliveryLateText(late: number): string {
  const count = Math.max(0, Math.round(Number(late) || 0))
  if (!count) return ''
  return '其中 ' + count + ' 次发出超过 ' + REMIND_LATE_DAYS + ' 天，可以提一句。'
}

/** 11-15：只说月日，与收据、档案里那些时间同一个写法。 */
export function monthDayText(at: string): string {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** 277,725 B：与界面、收据上同一口径（千分位 + 空格 + B）；没有字节数就是空串。 */
function bytesText(bytes?: number): string {
  const value = Math.max(0, Math.round(Number(bytes) || 0))
  return value ? value.toLocaleString('zh-CN') + ' B' : ''
}

/**
 * 不再等这一份回执的那一句（v0.9.158）：行首写「已不再等回执」，不再写「还没收到回执」。
 * 这两句不是一回事：一个是「还没回来」，一个是「不等了」。
 */
export function deliveryWaitClosedLead(): string {
  return '已不再等回执'
}

/** 那一行 title：哪天收的口、为什么不再催、之后他要是回了算不算。 */
export function deliveryWaitClosedHint(at: string): string {
  const when = monthDayText(at)
  return (
    (when ? when + ' 你自己把这一份收口了：' : '你自己把这一份收口了：') +
    '不再等它的回执——客户口头说过了、当面看过、或者这版本来就作废了，这些都可以收口。' +
    '工作台不再把它算进「还没回来」，也不再给复制提醒、换链接、换个渠道问这些动作：这一份已经不追了。' +
    '档案、封存包、回执链接都照留；他之后要是把收据贴回来，照样记在这一条上。'
  )
}

/** 清单顶上那句：有几条你自己收口了——它们不在「还没回来」里，所以单说一句。 */
export function deliveryWaitClosedTotalText(count: number): string {
  const n = Math.max(0, Math.round(Number(count) || 0))
  return n ? '另有 ' + n + ' 次你已经不再等回执了。' : ''
}

export type DeliveryChannelInput = {
  /** 作品名 */
  title: string
  /** 第几版 */
  version?: number
  /** 交付时间（发出去的那一天） */
  at?: string
  /** 这一条是给谁的（v0.9.152）：写了就用「王老师，」开头；没写就不加称呼 */
  recipient?: string
}

/**
 * 换个渠道问一句（v0.9.157）。
 *
 * 催过几次、三天以上还是没动静时，再发一遍「打开校验.html 拖进去」多半还是没动静——
 * 问题可能不在「他忘了」，而在这条消息根本没送到他手上。所以这一段不教怎么验包，
 * 只问一句收到没有、要不要换一种发法（直接发文件 / 发邮箱）。
 *
 * 边界：不写「已读请回复」，不编原因，也不替发件人答应赔偿或重发；
 * 不把「催过 N 次」写进话里——那是发件人自己的账，说给对方听就成了责备。
 */
export function deliveryChannelText(input: DeliveryChannelInput): string {
  const title = String(input?.title || '').trim()
  const version = Math.max(0, Math.round(Number(input?.version) || 0))
  const when = monthDayText(String(input?.at || ''))

  // 作品名缺了就只说这一份，不拼出「这份包那份包」
  const head = title ? title + (version ? ' 第 v' + version + ' 版' : '') + '那份包' : version ? '第 v' + version + ' 版那份包' : '这份包'
  const sent = when ? '我 ' + when + ' 发你的' : '我上次发你的'
  return (
    recipientGreeting(input?.recipient) +
    head + sent + '，一直没等到你的回执。' +
    '可能只是没看到，也可能是链接在微信里打不开：链接打得开吗？要不要我直接发你文件，或者发到你的邮箱？' +
    '\n已经验过的话，把收据或那段结论发我，我这边记上。'
  )
}

export type DeliveryReminderInput = {
  /** 作品名 */
  title: string
  /** 第几版 */
  version: number
  /** 包名：收包人手上那个 zip 的名字，用来让他确认「就是这一份」 */
  fileName?: string
  bytes?: number
  /** 交付时间（发出去的那一天） */
  at?: string
  /** 回执链接：收包人贴收据的地方；拿不到时退化成「把收据发我」 */
  link: string
  /** 这一条是给谁的（v0.9.152）：写了就用「王老师，」开头；没写就不加称呼，也不写「你好」 */
  recipient?: string
}

/**
 * 提醒他验包的那一段话（v0.9.144）。
 * 发件人贴在微信 / 邮件里就能发出去：先说清是哪一份、哪天发的，再说打开包里那张
 * 「校验.html」怎么验、验完把收据贴到哪儿，最后一句只说「哪一项不一样告诉我」——
 * 不写「已读请回复」，也不替发件人答应重发或赔偿。
 */
export function deliveryReminderText(input: DeliveryReminderInput): string {
  const title = String(input?.title || '').trim()
  const version = Math.max(0, Math.round(Number(input?.version) || 0))
  const fileName = String(input?.fileName || '').trim()
  const size = bytesText(input?.bytes)
  const when = monthDayText(String(input?.at || ''))
  const link = String(input?.link || '').trim()

  // 作品名缺了就只说这一份：不拼出「这份包那份包」这种叠词
  const head = title ? title + (version ? ' 第 v' + version + ' 版' : '') + '那份包' : version ? '第 v' + version + ' 版那份包' : '这份包'
  const detail = fileName && size ? '（' + fileName + '，' + size + '）' : fileName ? '（' + fileName + '）' : size ? '（' + size + '）' : ''
  const sent = when ? '我 ' + when + ' 发你的' : '我上次发你的'
  const ask = link
    ? '对得上就点「带走这份结论」，把收据贴回这条链接：\n' + link
    : '对得上就点「带走这份结论」，把收据发我就行。'
  return (
    recipientGreeting(input?.recipient) +
    head + detail + sent + '，还等你验一下：打开里面的「校验.html」，把收到的 zip 拖进去对一遍；' +
    ask +
    '\n哪一项不一样，把那一项告诉我就行。'
  )
}