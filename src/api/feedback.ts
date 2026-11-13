import { request } from './client'

// 应用内反馈：提交不要求登录（登录页也能用），读自己的条目要登录。
// 管理员在后台「反馈」里改状态并写回复，回复会随条目回到这里。

export type FeedbackKind = 'problem' | 'idea' | 'other'
export type FeedbackStatus = 'new' | 'reading' | 'done'

export type FeedbackItem = {
  id: string
  kind: FeedbackKind
  body: string
  contact: string
  page: string
  status: FeedbackStatus
  reply: string
  userId: string
  userEmail: string
  createdAt: string
  updatedAt: string
  resolvedAt: string
  handledBy: string
}

export type FeedbackQueue = {
  items: FeedbackItem[]
  total: number
  counts: { new: number; reading: number; done: number; total: number }
  kinds: Record<FeedbackKind, string>
  statuses: Record<FeedbackStatus, string>
}

export function submitFeedback(input: {
  kind: FeedbackKind
  body: string
  contact?: string
  page?: string
}): Promise<{ ok: boolean; id: string; duplicate: boolean; status: FeedbackStatus }> {
  return request('/api/feedback', { method: 'POST', body: JSON.stringify(input) })
}

export function listMyFeedback(limit = 6): Promise<{ ok: boolean; items: FeedbackItem[] }> {
  return request('/api/feedback/mine?limit=' + limit)
}

export function listFeedback(status: 'new' | 'reading' | 'done' | 'all' = 'new'): Promise<FeedbackQueue> {
  return request<FeedbackQueue>('/api/admin/feedback?status=' + status)
}

export function updateFeedback(
  id: string,
  input: { status: FeedbackStatus; reply?: string },
): Promise<{ ok: boolean; item: FeedbackItem; counts: FeedbackQueue['counts'] }> {
  return request('/api/admin/feedback/' + id, { method: 'POST', body: JSON.stringify(input) })
}
