import { request } from './client'

// 按次算账（v0.9.81）：后台只读接口。收入是「积分 × 档位汇率」的理论值，
// 成本是「用量 × 管理员填的上游估算单价」，两者都不是账单——页面沿用同一句说明。
// 算不出来的行（没定价 / 只有回填记录）服务端会标 costKnown=false 并给出原因，前端不补 0。

export type PricingPlanRate = {
  id: string
  name: string
  credits: number
  priceCents: number
  rmbPerCredit: number
}

export type PricingRate = {
  rmbPerCredit: number
  source: 'plan' | 'custom' | 'none'
  planId: string
  planName: string
  rows: PricingPlanRate[]
}

export type PricingRow = {
  action: string
  label: string
  unit: string
  credits: number
  billable: boolean
  subsidized: boolean
  /** 一次成本的分母是单位（张 / 秒）而不是请求：画布出图 / 出视频这两行是 true */
  perUnit: boolean
  revenueMilli: number | null
  measured: number
  calls: number
  failedCalls: number
  units: number
  costMilli: number
  unitCostMilli: number | null
  costKnown: boolean
  costReason: string
  marginMilli: number | null
  marginPct: number | null
}

export type PricingEstimate = {
  ok: boolean
  days: number
  window: { from: string; to: string }
  currency: string
  creditPrices: Record<string, number>
  pricesPriced: boolean
  pricesUpdatedAt: string
  pricesUpdatedBy: string
  rate: PricingRate
  plans: PricingPlanRate[]
  rows: PricingRow[]
  totals: {
    measured: number
    costMilli: number
    revenueMilli: number | null
    marginMilli: number | null
    unbilledCostMilli: number
  }
  warnings: string[]
}

export const getPricingEstimate = (options: { days?: number; planId?: string; rate?: number } = {}) => {
  const query = new URLSearchParams()
  query.set('days', String(options.days || 30))
  if (options.planId) query.set('plan', options.planId)
  if (options.rate && options.rate > 0) query.set('rate', String(options.rate))
  return request<PricingEstimate>('/api/admin/pricing/estimate?' + query.toString())
}

/** 每积分多少钱：档位汇率最多 6 位小数，写不下就写「—」，不四舍五入成一个假数字。 */
export function rateText(rate: number): string {
  const value = Number(rate) || 0
  if (!value) return '—'
  if (value < 0.0001) return '¥' + value.toExponential(2)
  return '¥' + value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}
