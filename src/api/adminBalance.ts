import { request } from './client'

// 后台「上游渠道余额」：按渠道列清楚还剩多少钱，低于阈值标红。
// 令牌只回掩码与「有没有」，明文永远不出服务端。
export type UpstreamBalanceChannel = {
  id: string
  label: string
  /** newapi = 能用访问令牌自动读；manual = 上游没有余额接口，只能手动登记 */
  kind: 'newapi' | 'manual'
  baseUrl: string
  note: string
  threshold: number
  amount: number | null
  used: number | null
  currency: string
  source: '' | 'auto' | 'manual'
  checkedAt: string
  error: string
  state: 'low' | 'ok' | 'unknown'
  hasToken: boolean
  tokenMask: string
  hasNewApiUser: boolean
  manualAmount: number | null
  updatedAt: string
  updatedBy: string
}

export type UpstreamBalanceResponse = {
  ok: boolean
  channels: UpstreamBalanceChannel[]
  low: string[]
  checkedAt: string
  ttlMs: number
  defaultThreshold: number
}

export type SaveBalanceInput = {
  channelId: string
  accessToken?: string
  newApiUser?: string
  threshold?: number
  manualAmount?: number | null
  currency?: string
  clearToken?: boolean
}

export function getUpstreamBalance(): Promise<UpstreamBalanceResponse> {
  return request<UpstreamBalanceResponse>('/api/admin/upstream-balance')
}

export function saveUpstreamBalanceChannel(input: SaveBalanceInput) {
  return request<{ ok: boolean; channel: UpstreamBalanceChannel; tokenKept: boolean }>(
    '/api/admin/upstream-balance/channel',
    { method: 'PUT', body: JSON.stringify(input) },
  )
}

export function checkUpstreamBalance(channelId: string) {
  return request<{ ok: boolean; error: string; channel: UpstreamBalanceChannel; channels: UpstreamBalanceChannel[] }>(
    '/api/admin/upstream-balance/check',
    { method: 'POST', body: JSON.stringify({ channelId }) },
  )
}
