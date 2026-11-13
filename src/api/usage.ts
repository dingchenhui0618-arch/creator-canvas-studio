import { request } from './client'

// 成本页读的是服务端 usage_events 的逐条事件，不是估出来的数字。
// 单价是管理员填的估算口径：没填就只统计用量（priced=false），前端不编金额。

export type UsagePrices = {
  inPerMillion: number
  outPerMillion: number
  imagePerShot: number
  videoPerSecond: number
  searchPerCall: number
  replicatePerCall: number
  runPerCall: number
  judgePerCall: number
}

export type UsageKindRow = {
  kind: string
  label: string
  calls: number
  failedCalls: number
  tokensIn: number
  tokensOut: number
  units: number
  unit: string
  estCostMilli: number
}

export type UsageDayRow = {
  day: string
  calls: number
  tokens: number
  images: number
  videoSeconds: number
  estCostMilli: number
}

export type UsageModelRow = {
  model: string
  calls: number
  tokensIn: number
  tokensOut: number
  estCostMilli: number
}

export type UsageEventRow = {
  id: string
  at: string
  kind: string
  label: string
  model: string
  source: string
  projectId: string
  ref: string
  ok: boolean
  tokensIn: number
  tokensOut: number
  units: number
  unit: string
  tokensKnown: boolean
  detail: string
}

export type UsageResponse = {
  ok: boolean
  days: number
  window: { from: string; to: string }
  prices: UsagePrices
  priced: boolean
  priceNote: string
  currency: string
  priceUpdatedAt: string
  priceUpdatedBy: string
  totals: {
    calls: number
    okCalls: number
    failedCalls: number
    tokensIn: number
    tokensOut: number
    images: number
    videoSeconds: number
    estCostMilli: number
  }
  byKind: UsageKindRow[]
  byModel: UsageModelRow[]
  byDay: UsageDayRow[]
  backfill: { count: number; at: string }
  recent: UsageEventRow[]
  kinds: { kind: string; label: string }[]
}

export const getUsage = (days = 14) => request<UsageResponse>('/api/admin/usage?days=' + days)

export const saveUsagePrices = (prices: Partial<UsagePrices>) =>
  request<{ ok: boolean; prices: UsagePrices; priced: boolean; updatedAt: string; updatedBy: string }>(
    '/api/admin/usage/prices',
    { method: 'PUT', body: JSON.stringify(prices) },
  )

/** 毫元 → 元：金额是估算，保留两位就够，别在小数上装精确。 */
export function formatCost(milli: number): string {
  const value = Number(milli) || 0
  if (!value) return '0.00'
  if (value < 1) return (value / 1000).toFixed(4)
  return (value / 1000).toFixed(2)
}
