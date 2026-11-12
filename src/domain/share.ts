import type { ShareVisits } from './project'

/**
 * 分享链接的文案与时间写法：作品页面板、历史链接、工作台汇总共用一处。
 * 三处分开写的话，「微信内打开 / 手机或平板」迟早有一处变成「移动端」。
 */
export const CLIENT_LABEL: Record<string, string> = {
  wechat: '微信内打开',
  mobile: '手机或平板',
  desktop: '电脑浏览器',
  other: '未知设备',
}

/** 「多久之前」：回答最近一次，不假装精确到秒 */
export function ago(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  return Math.floor(hours / 24) + ' 天前'
}

/** 分享与历史里统一的时间写法：MM-DD HH:mm */
export function stampTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad2 = (value: number) => String(value).padStart(2, '0')
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 「N 次打开 · 最近 X（客户端）」里最近那半句 */
export function visitLine(visits: ShareVisits): string {
  const client = CLIENT_LABEL[visits.lastClient] || '未知设备'
  return '最近 ' + ago(visits.lastAt) + '（' + client + '）'
}
