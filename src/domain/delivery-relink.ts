// 换一条新链接（v0.9.147）。
//
// 上一版让那一行在「又发过两次还是没人打开」时直说「同一条再发也没用了，换个方式，或者换一条新链接」，
// 但手上没有这个动作：得回作品页找到那一版、点换链接、再自己组织一段话。这一支把这步接到同一行上。
//
// 边界：
//  - 只换「确知一次都没被打开过」的地址：打开过的地址可能正被看着，换掉等于把送到的那条收回；
//  - 换的是地址，不是包：包名、字节、哈希、交付时间一概不动；旧地址立刻打不开，话里要说清；
//  - 说「你那边一直没打开过」可以（那是记录里的事实），不说「你打不开」「你收到没」——
//    我们只知道这条地址没被点开过，不知道是谁、为什么。

// 带 .ts 后缀：这一支要被 node --test 直接加载，Node 的解析器不猜后缀。
import { deliveryOpenWithResend } from './delivery-resend.ts'
import type { DeliveryVisits } from './project.ts'

/** 那一行上的一句话：换过几次。没换过就是空串。 */
export function deliveryRelinkText(relink: { count?: number } | null | undefined): string {
  const count = Math.max(0, Math.round(Number(relink?.count) || 0))
  return count ? '换过 ' + count + ' 次链接' : ''
}

/** 作品页档案读的是记录里的时间数组：没有就 null，界面据此不写这句。 */
export function deliveryRelinkBrief(
  relinks: { at?: string; resends?: number }[] | null | undefined,
): { count: number; at: string; resends: number } | null {
  const list = (Array.isArray(relinks) ? relinks : []).filter((entry) => entry && entry.at)
  if (!list.length) return null
  const last = list[list.length - 1]
  return {
    count: list.length,
    at: String(last.at || ''),
    resends: Math.max(0, Math.round(Number(last.resends) || 0)),
  }
}

/**
 * 档案里那句要长一点：换过几次，还要带上「换掉之前那条发过几次没打开」——
 * 只写「换过 1 次链接」看不出换的理由，也看不出这一条到底试过几条地址。
 */
export function deliveryRelinkDetail(relink: { count?: number; resends?: number } | null | undefined): string {
  const count = Math.max(0, Math.round(Number(relink?.count) || 0))
  if (!count) return ''
  const before = Math.max(0, Math.round(Number(relink?.resends) || 0))
  return '换过 ' + count + ' 次链接' + (before ? '（上一条发过 ' + before + ' 次没打开）' : '')
}

/**
 * 那一行胶囊的 title：说清「换了意味着什么」。
 * 没换过 = 这条看着不像会被打开，换一条新的（旧地址立刻作废）；
 * 换过 = 两条地址都没人打开，别再换地址了，先问一句或者换个收件人。
 */
export function deliveryRelinkHint(relink: { count?: number; resends?: number } | null | undefined): string {
  const count = Math.max(0, Math.round(Number(relink?.count) || 0))
  if (count >= 1) {
    return '已经换过 ' + count + ' 次新地址还是没被打开：别再换地址了，先问他一句，或者换个收件人'
  }
  const before = Math.max(0, Math.round(Number(relink?.resends) || 0))
  if (!before) return ''
  return '这条地址发过 ' + before + ' 次都没被打开：换一条新地址（旧的那条立刻打不开）'
}

/** 清单顶上那句：换过新地址、新地址也没人打开的几次。一个都没有就是空串。 */
export function deliveryRelinkedText(count: number): string {
  const n = Math.max(0, Math.round(Number(count) || 0))
  if (!n) return ''
  return '其中 ' + n + ' 次连换过的地址也没人打开：问题可能不在链接上，先问他一句，或者换个收件人。'
}

/**
 * 作品页那一行灰字：打开情况 + 换过几次 + 又发过几次，合成一句。
 * 只知道其中一件时就只说那一件；一件都不知道就是空串，这一行不出现。
 */
export function deliveryArchiveLine(
  visits: DeliveryVisits | null | undefined,
  resend: { count?: number } | null | undefined,
  relink: { count?: number; resends?: number } | null | undefined,
): string {
  const base = deliveryOpenWithResend(visits, resend)
  const kept = deliveryRelinkDetail(relink)
  if (!kept) return base
  return base ? base + ' · ' + kept : kept
}

/** 与「再发一次」同一套输入：换的只是地址，包的事实一个字都不变。 */
export type DeliveryRelinkInput = {
  title: string
  version: number
  fileName?: string
  bytes?: number
  at?: string
  /** 换完之后的新地址：这一条就是重新发出去的东西 */
  link: string
}

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
 * 换过链接之后的那段话（v0.9.147）。
 * 要说清「这是新地址、旧的那条已经打不开」——不然对方从聊天记录里点回旧的那条，
 * 得到的是「这条回执链接不在了」，比没收到更让人糊涂。
 * v0.9.148 起旧地址自己会说「已经换成新的了」，这段话里也照实写一句，免得他点回去以为出了别的事。
 */
export function deliveryRelinkMessage(input: DeliveryRelinkInput): string {
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
    ? '那条回执链接你那边一直没打开过，我换了一条新的：\n' +
      link +
      '\n这一条和之前那条不是同一个地址，旧的那条已经打不开了（打开会提示已换成新地址），用这一条就行。' +
      '\n打开这一页，把收到的 zip 拖进包里的「校验.html」对一遍，验完点「带走这份结论」，把收据贴回这条链接就行。'
    : '那条回执链接你那边一直没打开过。收到了打开包里的「校验.html」对一遍，验完把收据发我就行。'
  return head + detail + sent + '，' + tail + '\n要是这一条也打不开，跟我说一声，我换一种方式发给你。'
}
