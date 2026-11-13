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
  // 说明列：服务端从 meta 里取的用户可读说明（例如这条复刻的标题）
  label?: string
  createdAt: string
}

/** 每月额度：unlimited 为真时 remaining 是 -1，界面照实显示「未设上限」，不编数字。 */
export type CreditQuota = {
  limit: number
  used: number
  remaining: number
  unlimited: boolean
  overridden: boolean
  month: string
  resetAt: string
  defaultLimit: number
  updatedAt: string
  updatedBy: string
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
  quota?: CreditQuota
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
  /** 注册留痕：同意的条款版本与时间；管理员开通的账号是 admin-created */
  termsVersion?: string
  termsAcceptedAt?: string
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

// 模型服务是否真的能出结果：取最近一次真实调用的结论，不是「接口能不能连」。
// 生产只拿到 available / message；内部环境额外带 code、上游报文与失败时间用于排障。
export type ModelServiceState = {
  available: boolean
  message: string
  retryAfterSec?: number
  code?: string
  detail?: string
  upstream?: string
  since?: string | null
  count?: number
  lastModel?: string
}

export const getCredits = (limit = 20, offset = 0) =>
  request<CreditsResponse>('/api/credits?limit=' + limit + '&offset=' + offset)

export const getModelService = () => request<{ ok: boolean; model: ModelServiceState }>('/api/system/service')

// 管理员处理完之后由界面「重新检测」放行一次真实请求
export const recheckModelService = () =>
  request<{ ok: boolean; cleared: boolean }>('/api/system/service/recheck', { method: 'POST' })

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


export type CreditRequest = {
  id: string
  userId: string
  email: string
  name: string
  amount: number
  reason: string
  status: 'pending' | 'granted' | 'ignored'
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  grantedAmount: number | null
  /** 档位快照：申请时谈定的那一笔（档位后来改名/改价/删除都不影响已提交的单据） */
  planId: string
  planName: string
  priceCents: number | null
}

// 额度申请：积分不够时的出口。带档位时数量与价格以服务端为准，客户端只传 planId。
export const getMyCreditRequest = () =>
  request<{ ok: boolean; pending: CreditRequest | null; items: CreditRequest[] }>('/api/credits/request')

export const requestCredits = (amount: number, reason: string) =>
  request<{ ok: boolean; created: boolean; request: CreditRequest; pending: CreditRequest | null; items: CreditRequest[] }>(
    '/api/credits/request',
    {
      method: 'POST',
      body: JSON.stringify({ amount, reason }),
    },
  )

/** 按后台档位申请开通：服务端用档位里的积分与价格，不接受客户端改数量。 */
export const requestPlan = (planId: string, reason = '') =>
  request<{ ok: boolean; created: boolean; request: CreditRequest; pending: CreditRequest | null; items: CreditRequest[] }>(
    '/api/credits/request',
    {
      method: 'POST',
      body: JSON.stringify({ planId, reason }),
    },
  )

export const listCreditRequests = (status = '') =>
  request<{ items: CreditRequest[]; total: number; pending: number }>('/api/admin/credit-requests' + (status ? '?status=' + status : ''))

export const resolveCreditRequest = (id: string, body: { action: 'grant' | 'ignore'; amount?: number }) =>
  request<{ ok: boolean; request: CreditRequest; balance: number | null }>('/api/admin/credit-requests/' + id, {
    method: 'POST',
    body: JSON.stringify(body),
  })

// 后台建号：不填口令时服务端生成一次性临时口令（只在这次响应里返回）。
// 建完账本里会有两笔：服务端给的初始额度 + 管理员追加的额度。
export const createAdminUser = (input: { email: string; name?: string; kind?: 'admin' | 'account'; password?: string; credits?: number }) =>
  request<{ ok: boolean; password: string; balance: number; user: AdminUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
// 管理员重置口令：不带密码时服务端生成临时口令，只在这一次响应里返回。
export const resetAdminPassword = (userId: string, password?: string) =>
  request<{ ok: boolean; password: string; signedOut: number; user: AdminUser }>('/api/admin/users/' + userId + '/password', {
    method: 'POST',
    body: JSON.stringify(password ? { password } : {}),
  })

export type AdminInvite = {
  id: string
  code: string
  createdBy: string
  maxUses: number
  used: number
  remaining: number
  credits: number
  note: string
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  status: 'active' | 'used' | 'revoked' | 'expired'
  /** 最近 5 次使用：谁用的、来源哈希前 8 位、时间（排查一码多传） */
  uses?: { email: string; ip: string; createdAt: string }[]
}

export type AdminInvitesResponse = {
  items: AdminInvite[]
  total: number
  active: number
  used: number
  revoked: number
  expired: number
  limits: { maxPerIp: number; windowHours: number }
}

export const listAdminInvites = () => request<AdminInvitesResponse>('/api/admin/invites')

// 签发：码只在这次响应里回明文，后台要当场复制给受邀人
export const createAdminInvite = (input: { maxUses?: number; days?: number; credits?: number; note?: string }) =>
  request<{ ok: boolean; invite: AdminInvite }>('/api/admin/invites', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const revokeAdminInvite = (inviteId: string) =>
  request<{ ok: boolean; changed: boolean; invite: AdminInvite }>('/api/admin/invites/' + inviteId + '/revoke', {
    method: 'POST',
    body: '{}',
  })

// 流水类型的中文名：服务端只存 kind，展示层在这里翻译
export const CREDIT_KIND_LABEL: Record<string, string> = {
  invite: '邀请码赠送',
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
