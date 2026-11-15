// 问一句「你那边收到没有」（v0.9.150）。
//
// 到这一步（换过两次地址、每一条都没被打开过）工具不该再换第三条：换的是 token，不是渠道。
// 剩下的两个动作是「问他一句」和「换个人」，这一支只负责把第一件写成能直接发出去的话。
//
// 边界：
//  - 只写记录里有的事实：哪一版、包名、多少字节、哪天发的、现在这条地址；
//  - 「一次都没打开过」是数出来的——每换一条都要求上一条打开次数是零，走到这一步就是几条都没打开；
//  - 不承诺重发、不替发件人道歉，也不说「你怎么不看」；结尾把两种可能都留出来：打不开 / 不是你。

import { recipientGreeting } from './delivery-recipient.ts'

export type DeliveryAskInput = {
  title: string
  version: number
  fileName?: string
  bytes?: number
  /** 交付那天（发出去的那一天） */
  at?: string
  /** 现在这条回执地址 */
  link?: string
  /** 这一条是给谁的（v0.9.152）：写在开头，称呼没有就不写 */
  recipient?: string
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

function monthDay(at: string): string {
  const ms = Date.parse(String(at || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate())
}

function bytesText(bytes?: number): string {
  const value = Math.max(0, Math.round(Number(bytes) || 0))
  return value ? value.toLocaleString('zh-CN') + ' B' : ''
}

/**
 * 问他一句：这一份我发了不止一次，你那边一次都没打开过——是不是没收到？
 * 后面直接给出现在的地址（到这里换地址已经换到头了，能给的只有这条），再把「怎么验」一句话带过。
 */
export function deliveryAskMessage(input: DeliveryAskInput): string {
  const title = String(input?.title || '').trim()
  const version = Math.max(0, Math.round(Number(input?.version) || 0))
  const fileName = String(input?.fileName || '').trim()
  const size = bytesText(input?.bytes)
  const when = monthDay(String(input?.at || ''))
  const link = String(input?.link || '').trim()

  const head = title ? title + (version ? ' 第 v' + version + ' 版' : '') + '那份包' : version ? '第 v' + version + ' 版那份包' : '这份包'
  const detail = fileName && size ? '（' + fileName + '，' + size + '）' : fileName ? '（' + fileName + '）' : size ? '（' + size + '）' : ''
  const sent = when ? '我 ' + when + ' 发你的' : '我上次发你的'
  const middle = '。这一份的链接我前前后后试过几次，你那边一次都没打开过——是不是没收到？'
  const now = link
    ? '现在这条地址是：\n' + link + '\n'
    : ''
  const tail = link
    ? '收到了就打开里面的「校验.html」，把收到的 zip 拖进去对一遍，验完点「带走这份结论」，把收据贴回这条链接就行。要是打不开、或者这条消息不是你收的，跟我说一声，我换个方式发。'
    : '收到了就打开里面的「校验.html」，把收到的 zip 拖进去对一遍，验完点「带走这份结论」，把收据发我就行。要是没收到，跟我说一声，我换个方式发。'
  return recipientGreeting(input?.recipient) + head + detail + sent + middle + '\n' + now + tail
}
