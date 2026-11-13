// 每月额度（v0.9.64）：配额是数据，不是代码里的常量。
// 后台「计费 → 每月额度」读写这几条接口；0 表示不限，是默认值，没定之前不替用户设上限。
import { request } from './client'

export type QuotaRow = {
  userId: string
  email: string
  name: string
  kind: string
  active: boolean
  credits: number
  /** 本月已消耗的积分（扣费 - 退款，按 UTC 自然月） */
  used: number
  /** 单独额度；null 表示走默认额度 */
  override: number | null
  /** 实际生效的上限；0 表示不限 */
  limit: number
  unlimited: boolean
}

export type AdminQuota = {
  ok: boolean
  monthlyLimit: number
  updatedAt: string
  updatedBy: string
  month: string
  resetAt: string
  overrideCount: number
  rows: QuotaRow[]
}

export const getAdminQuota = () => request<AdminQuota>('/api/admin/quota')

export const saveAdminQuota = (monthlyLimit: number) =>
  request<AdminQuota>('/api/admin/quota', { method: 'PUT', body: JSON.stringify({ monthlyLimit }) })

export const setQuotaOverride = (userId: string, limit: number) =>
  request<AdminQuota>('/api/admin/quota/overrides/' + userId, { method: 'PUT', body: JSON.stringify({ limit }) })

export const clearQuotaOverride = (userId: string) =>
  request<AdminQuota>('/api/admin/quota/overrides/' + userId, { method: 'DELETE' })
