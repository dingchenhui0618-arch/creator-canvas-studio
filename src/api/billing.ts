// 充值接口：契约先定下来，支付和计费还没接入。
// 约定：通道未开通时服务端返回 enabled:false，前端只展示状态，不伪造价格、余额或订单。
import { request } from './client'

export type BillingPlan = {
  id: string
  name: string
  price: number
  credits: number
  note: string
}

export type BillingOverview = {
  ok: boolean
  enabled: boolean
  currency: string
  provider: string | null
  plans: BillingPlan[]
  balance: { credits: number | null; unit: string; updatedAt: string | null }
  message: string
}

export const getBillingOverview = () => request<BillingOverview>('/api/billing/overview')

export type BillingOrder = { id: string; status: string; createdAt: string }

export const listBillingOrders = () => request<{ items: BillingOrder[]; total: number }>('/api/billing/orders')

// 通道未开通时服务端回 501 BILLING_NOT_CONFIGURED；到这里之前先看 overview.enabled
export const createBillingOrder = (planId: string) =>
  request<BillingOrder>('/api/billing/orders', { method: 'POST', body: JSON.stringify({ planId }) })
