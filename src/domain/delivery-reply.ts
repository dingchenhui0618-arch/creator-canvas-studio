// 他回了什么（v0.9.153）。
//
// r136–r152 把「交出去」这一侧做全了：封了包、给了回执链接、收包人点了「收到了」、
// 贴回收据之后还能比对出版次对不对。可收据只给一个结论——对得上、对不上、看不清。
// 他真正说的那句「第 3 张背景色偏了，第 5 张再亮一点」没有地方落：
// 抄在聊天里会丢，抄在作品备注里会跟「这一版交的是哪一份」脱开。
//
// 所以这一段话记在这一条交付上，跟着版次、跟着包、跟着回执走：
//  - 只记发件人自己写下来的原话：不替他总结，也不猜他是满意还是不满意；
//  - 没记 = 什么都没说，界面不写「他说没问题」，也不写「没有回复」这种像结论的话；
//  - 只在发件人这一侧：不进包、不进回执页——拿到链接的人不需要看见自己的话被存了一份；
//  - 时间记的是「记下这段话」的那一刻，不是他回话的那一刻（那一侧没有时间戳可看）。

import type { DeliveryReply } from './project'

export const REPLY_LIMIT = 200
export const REPLY_LINES = 6

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 写进来、读回来都过这一遍：去控制字符、每行空白压成一个、空行扔掉、最多 6 行、按字截到 200 */
export function normalizeReply(raw: string | null | undefined): string {
  // 换行留着（回复可能是一串要改的点），其余控制字符换成空格：粘进来的制表符不该在行上撑出空白。
  const flat = Array.from(String(raw ?? ''))
    .map((ch) => {
      const code = ch.codePointAt(0) || 0
      if (code === 0x0a) return '\n'
      return code < 0x20 || code === 0x7f ? ' ' : ch
    })
    .join('')
  const text = flat
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, REPLY_LINES)
    .join('\n')
  return Array.from(text).slice(0, REPLY_LIMIT).join('')
}

/** 接口读回来的那一项：只认 { text } 是字符串的对象，坏值当成还没记 */
export function replyOf(value: unknown): DeliveryReply | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { text?: unknown; at?: unknown }
  const text = normalizeReply(typeof record.text === 'string' ? record.text : '')
  if (!text) return null
  const at = Number.isFinite(Date.parse(String(record.at || ''))) ? String(record.at) : ''
  return { text, at }
}

/** 记下的时刻：'11-15 21:04'；时间读不出来就是空串，不硬编一个 */
export function replyAtText(reply: DeliveryReply | null | undefined): string {
  const ms = Date.parse(String(reply?.at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 档案里那一行：'记于 11-15 21:04'；时间没有就什么都不说 */
export function replySavedAt(reply: DeliveryReply | null | undefined): string {
  const at = replyAtText(reply)
  return at ? '记于 ' + at : ''
}

/** 工作台那一行：只放第一行（后面还有就加省略号），整段在 title 里 */
export function replyRowText(reply: DeliveryReply | null | undefined): string {
  const text = normalizeReply(reply?.text)
  if (!text) return ''
  const lines = text.split('\n')
  return '他说：' + lines[0] + (lines.length > 1 ? '…' : '')
}

/** 那一行的 title：原话全文 + 记下的时间 + 只有你看得到 */
export function replyRowTitle(reply: DeliveryReply | null | undefined): string {
  const text = normalizeReply(reply?.text)
  if (!text) return ''
  const at = replyAtText(reply)
  return '他回的原话（只有你看得到：包里没有，拿到链接的人也看不到）' + (at ? '，' + at + ' 记下' : '') + '：\n' + text
}

/** 记下之后的说法：记的是「他说了什么」，不是「他说满意」 */
export function replySavedText(): string {
  return '已记下他回了什么'
}

/** 清掉：这一条回到「没有记」，不是「他说没问题」 */
export function replyClearedText(): string {
  return '已清掉回复：这一条回到「还没记」'
}

/** 编辑器空着时的样子：只说还没记，不替对方下结论 */
export function replyEmptyText(): string {
  return '还没记他回了什么'
}

/** 编辑框下面那一句：说清记在哪、不会出现在哪 */
export function replyHint(): string {
  return '只写给你自己看：他的原话、还要改哪几张。不进包，也不给收包人看。'
}

/** 输入框的示例，只当占位符用，不预填任何真实回复 */
export function replyPlaceholder(): string {
  return '第 3 张背景色偏了，第 5 张再亮一点'
}
