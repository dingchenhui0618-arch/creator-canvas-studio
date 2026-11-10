// 积分与系统状态：都是本轮新加的真实接口，没有就如实报错，不假装有数据。
import { request } from './client'

export type CreditPrices = { search: number; replicate: number; review: number; chat: number; flow_run: number }
export type CreditConcurrency = { search: number; replicate: number; review: number; chat: number; flow_run: number }

export type CreditEntry = {
  id: string
  delta: number
  balance: number
  kind: string
  ref: string
  createdAt: string
}

export type CreditsResponse = {
  ok: boolean
  unit: string
  balance: number | null
  prices: CreditPrices
  concurrency: CreditConcurrency
  ledger: CreditEntry[]
  ledgerTotal?: number
  ledgerOffset?: number
  ledgerLimit?: number
  billingEnabled: boolean
}

export type AdminUser = {
  id: string
  email: string
  name: string
  workspace: string
  kind: string
  active: boolean
  credits: number
  createdAt: string
  lastLoginAt: string | null
}

export type HealthCheck = {
  id: string
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  ms: number
}

export type SystemHealth = {
  ok: boolean
  status: 'ok' | 'warn' | 'fail'
  checkedAt: string
  checks: HealthCheck[]
}

export const getCredits = (limit = 20, offset = 0) =>
  request<CreditsResponse>('/api/credits?limit=' + limit + '&offset=' + offset)

export const getSystemHealth = () => request<SystemHealth>('/api/system/health')

export const listAdminUsers = () => request<{ items: AdminUser[]; total: number }>('/api/admin/users')

export const updateAdminUser = (userId: string, patch: { active?: boolean; kind?: 'admin' | 'account' }) =>
  request<{ ok: boolean; user: AdminUser }>('/api/admin/users/' + userId, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

// 删除账号：只删登录与积分；模板、画布与运行记录保留（服务端决定，不在界面假装一并清空）
export const deleteAdminUser = (userId: string) =>
  request<{ ok: boolean; id: string; email: string }>('/api/admin/users/' + userId, { method: 'DELETE' })

export const grantCredits = (userId: string, amount: number, note: string) =>
  request<{ ok: boolean; balance: number; ledger: CreditEntry[] }>('/api/admin/users/' + userId + '/credits', {
    method: 'POST',
    body: JSON.stringify({ amount, note }),
  })

// 管理员重置口令：不带密码时服务端生成临时口令，只在这一次响应里返回。
export const resetAdminPassword = (userId: string, password?: string) =>
  request<{ ok: boolean; password: string; signedOut: number; user: AdminUser }>('/api/admin/users/' + userId + '/password', {
    method: 'POST',
    body: JSON.stringify(password ? { password } : {}),
  })

// 流水类型的中文名：服务端只存 kind，展示层在这里翻译
export const CREDIT_KIND_LABEL: Record<string, string> = {
  search: '检索',
  'search-refund': '检索退款',
  replicate: '一键复刻',
  'replicate-refund': '复刻退款',
  review: '视觉评审',
  'review-refund': '评审退款',
  chat: '智能体对话',
  'chat-refund': '对话退款',
  flow_run: '画布运行',
  'flow_run-refund': '画布运行退款',
  grant: '管理员发放',
  deduct: '管理员扣减',
  welcome: '初始额度',
}

export function creditKindLabel(kind: string): string {
  return CREDIT_KIND_LABEL[kind] || kind
}
