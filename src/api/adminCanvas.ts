import { request } from './client'

// 画布身份：跨系统的账号视图，数据来自画布企业服务（VisionQA 服务端代理）。
export type CanvasIdentityAccount = {
  id: string
  email: string
  name: string
  active: boolean
}

export type CanvasIdentity = {
  id: number
  displayName: string
  active: boolean
  lastLoginAt: string
  createdAt: string
  visionqaUserId: string
  /** null = 这个画布身份对应的 VisionQA 账号已被删除 */
  account: CanvasIdentityAccount | null
}

export type CanvasIdentityList = {
  available: boolean
  reason?: string
  code?: string
  items: CanvasIdentity[]
  total: number
  summary?: { active: number; suspended: number; missing: number }
}

export const listCanvasIdentities = () => request<CanvasIdentityList>('/api/admin/canvas/users')

export const setCanvasIdentityAccess = (id: number, enabled: boolean) =>
  request<{ ok: boolean; item: { id: number; active: boolean; displayName: string } }>(`/api/admin/canvas/users/${id}/access`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
