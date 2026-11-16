// 充值接口（v0.9.162）：档位与积分口径都来自服务端，前端只负责如实渲染。
// 支付通道还没接入，所以「到账」是内测直充；余额不在这里伪造，真余额在 /api/credits。
import { request } from './client'

export type BillingPlan = {
  id: string
  name: string
  /** 元（由服务端把「分」折算好），例如 99.5 */
  price: number
  /** 分：整数，避免前端算钱时出现浮点尾巴 */
  priceCents: number
  credits: number
  note: string
}

export type BillingOverview = {
  ok: boolean
  /** 能不能自助到账：模式开着并且后台真的配了档位 */
  enabled: boolean
  currency: string
  /** 积分口径（1 元 = N 积分）：服务端配置是唯一真源，充值页与无限画布都读它 */
  pointsPerCny: number
  unit: string
  /** auto = 内测直充；off = 只能提交申请由管理员发放 */
  mode: 'auto' | 'off'
  provider: string | null
  plans: BillingPlan[]
  balance: { credits: number | null; unit: string; updatedAt: string | null }
  message: string
}

export const getBillingOverview = () => request<BillingOverview>('/api/billing/overview')

export type BillingOrder = {
  id: string
  planId: string
  planName: string
  credits: number
  priceCents: number
  channel: 'internal' | 'manual'
  status: 'paid' | 'pending'
  createdAt: string
}

export const listBillingOrders = () => request<{ items: BillingOrder[]; total: number }>('/api/billing/orders')

/** 选一档充：积分与金额一律按服务端档位算，客户端传的 credits 不作数。 */
export const createBillingOrder = (planId: string) =>
  request<{ ok: boolean; order: BillingOrder; credits: number; balance: number; unit: string }>(
    '/api/billing/orders',
    { method: 'POST', body: JSON.stringify({ planId }) },
  )
