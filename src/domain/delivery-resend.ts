// 链接没送到：就地把这一份再发一次（v0.9.146）。
//
// 为什么要有它：v0.9.145 让那一行说得出「这条链接还没被打开」。知道之后下一步只有两个——
// 把链接再发一次，或者换个方式发。这一段只做三件纯计算：
// 重发过几次怎么说、什么时候该换个方式、以及把「再发一次」写成一段能直接发出去的话。
//
// 边界：
//  - 只说「这条地址又发过一次」，不说「他没收到」——重发解决的是「可能没送到」，不是「他不要」；
//  - 不知道被打开过没有（升级前发的链接）就不重发、也不写次数：判断不了结果的动作不做；
//  - 重发的话只说档案里记着的事实（哪一版、哪个包、多少字节、哪天发的、链接），
//    不编原因、不道歉、也不替发件人答应换包或赔偿。

// 带 .ts 后缀：这一支要被 node --test 直接加载（Domain 层是纯函数，测试不吃构建），
// Node 的解析器不猜后缀，Vite 与 tsc（allowImportingTsExtensions）都认这种写法。
import { deliveryOpenDetail } from './delivery-open.ts'
import type { DeliveryVisits } from './project.ts'

/** 链接重发过几次还没被打开，就该换个方式发了：与 server/delivery-ledger.mjs 同一个门槛。 */
export const RESEND_STUCK_MIN = 2

/** 又发过几次：给那一行与档案里用的一句话；没重发过就是空串。 */
export function deliveryResendText(resend: { count?: number } | null | undefined): string {
  const count = Math.max(0, Math.round(Number(resend?.count) || 0))
  return count ? '又发过 ' + count + ' 次' : ''
}

/** 重发过的那几次（作品页读的是档案里的时间数组）：没有就 null，界面据此不写这句。 */
export function deliveryResendBrief(
  resends: { at?: string }[] | null | undefined,
): { count: number; at: string } | null {
  const list = (Array.isArray(resends) ? resends : []).filter((entry) => entry && entry.at)
  if (!list.length) return null
  return { count: list.length, at: String(list[list.length - 1].at || '') }
}

/** 给 title 的那句判断：重发过一次说「可以换个方式」，重发到门槛上就说「同一条再发也没用了」。 */
export function deliveryResendHint(resend: { count?: number } | null | undefined): string {
  const count = Math.max(0, Math.round(Number(resend?.count) || 0))
  if (!count) return ''
  if (count >= RESEND_STUCK_MIN) {
    return '这条地址已经又发过 ' + count + ' 次还是没被打开：同一条再发也没用了，换个方式发（邮件 / 换个人），或者换一条新链接'
  }
  return '这条地址已经又发过 ' + count + ' 次还是没被打开：可以换个方式发（邮件 / 换个人）'
}

/** 清单顶上那句：重发到门槛上还没打开的几次。一个都没有就是空串。 */
export function deliveryStuckText(stuck: number): string {
  const count = Math.max(0, Math.round(Number(stuck) || 0))
  if (!count) return ''
  return '其中 ' + count + ' 次链接又发过 ' + RESEND_STUCK_MIN + ' 次还没打开：换个人或换个方式发。'
}

/**
 * 作品页那一行灰字（v0.9.145 + v0.9.146）：打开情况与重发次数合成一句，不并成两行灰字。
 * 只知道其中一件时就只说那一件；两件都不知道就是空串，这一行不出现。
 */
export function deliveryOpenWithResend(
  visits: DeliveryVisits | null | undefined,
  resend: { count?: number } | null | undefined,
): string {
  const open = deliveryOpenDetail(visits)
  const again = deliveryResendText(resend)
  if (!open) return again
  return again ? open + ' · ' + again : open
}

export type DeliveryResendInput = {
  /** 作品名 */
  title: string
  /** 第几版 */
  version: number
  /** 包名：收包人手上那个 zip 的名字，用来让他确认「就是这一份」 */
  fileName?: string
  bytes?: number
  /** 交付时间（发出去的那一天） */
  at?: string
  /** 回执链接：这一条就是重新发出去的东西 */
  link: string
}

/** 11-15：与收据、档案里那些时间同一个写法。 */
function monthDay(at: string): string {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function bytesText(bytes?: number): string {
  const value = Math.max(0, Math.round(Number(bytes) || 0))
  return value ? value.toLocaleString('zh-CN') + ' B' : ''
}

/**
 * 再发一次链接的那段话（v0.9.146）。
 * 与「催他验」不同：那一段假设他收到了，这一段把地址重新给一次，并留一句「这条也打不开就说一声」——
 * 发件人下一次的判断（换渠道还是换人）全靠这一句回来的答案。
 */
export function deliveryResendMessage(input: DeliveryResendInput): string {
  const title = String(input?.title || '').trim()
  const version = Math.max(0, Math.round(Number(input?.version) || 0))
  const fileName = String(input?.fileName || '').trim()
  const size = bytesText(input?.bytes)
  const when = monthDay(String(input?.at || ''))
  const link = String(input?.link || '').trim()

  const head = title ? title + (version ? ' 第 v' + version + ' 版' : '') + '那份包' : version ? '第 v' + version + ' 版那份包' : '这份包'
  const detail = fileName && size ? '（' + fileName + '，' + size + '）' : fileName ? '（' + fileName + '）' : size ? '（' + size + '）' : ''
  const sent = when ? '我 ' + when + ' 发你的' : '我上次发你的'
  const tail = link
    ? '那条回执链接你那边可能没收到，这里再发一次：\n' +
      link +
      '\n打开这一页，把收到的 zip 拖进包里的「校验.html」对一遍，验完点「带走这份结论」，把收据贴回这条链接就行。'
    : '那条回执链接你那边可能没收到。收到了打开包里的「校验.html」对一遍，验完把收据发我就行。'
  return head + detail + sent + '，' + tail + '\n要是这条也打不开，跟我说一声，我换个方式发给你。'
}
