// 定价档位（v0.9.63）：后台维护、前端只读；价格由人定，代码不写死任何数字。
import { request } from './client'
import type { BillingPlan } from './billing'

/** 后台视角：比公开接口多 enabled / sort / 谁在什么时候改的。 */
export type AdminPlan = BillingPlan & {
  enabled: boolean
  sort: number
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export type PlanInput = {
  id?: string
  name: string
  credits: number
  priceCents: number
  note?: string
  enabled?: boolean
  sort?: number
}

export const listAdminPlans = () => request<{ ok: boolean; items: AdminPlan[]; total: number }>('/api/admin/plans')

export const createAdminPlan = (input: PlanInput) =>
  request<{ ok: boolean; plan: AdminPlan }>('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const updateAdminPlan = (id: string, input: PlanInput) =>
  request<{ ok: boolean; plan: AdminPlan }>('/api/admin/plans/' + id, {
    method: 'PUT',
    body: JSON.stringify(input),
  })

export const deleteAdminPlan = (id: string) =>
  request<{ ok: boolean; deleted: string }>('/api/admin/plans/' + id, { method: 'DELETE' })
