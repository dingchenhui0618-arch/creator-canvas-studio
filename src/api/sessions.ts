// 登录设备：只读写自己账号的会话。id 是服务端派生值，只能用来踢一条会话。
import { request } from './client'

export type LoginSession = {
  id: string
  createdAt: string
  expiresAt: number
  userAgent: string
  ip: string
  current: boolean
}

export const listLoginSessions = () =>
  request<{ sessions: LoginSession[]; total: number; current: string }>('/api/auth/sessions')

export const revokeOtherSessions = () =>
  request<{ ok: boolean; signedOut: number }>('/api/auth/sessions/revoke-others', { method: 'POST' })

export const revokeLoginSession = (id: string) =>
  request<{ ok: boolean }>('/api/auth/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
