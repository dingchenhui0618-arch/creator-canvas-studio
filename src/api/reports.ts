// 举报侵权 / 不当内容：分享页与公共模板都能用，不要求登录。
import { request } from './client'

export type ReportCategory = 'copyright' | 'portrait' | 'abuse' | 'other'

export type ReportTarget = { kind: 'template' | 'share'; id: string; title: string; url?: string }

export type ReportItem = {
  id: string
  at: string
  lastAt: string
  count: number
  status: 'open' | 'dismissed' | 'takedown'
  category: ReportCategory
  detail: string
  contact: string
  target: ReportTarget
  userId: string
  ip: string
  resolvedAt: string
  resolvedBy: string
  resolution: string
  note: string
}

export type ReportQueue = {
  items: ReportItem[]
  total: number
  open: number
  counts: { open: number; dismissed: number; takedown: number; total: number }
  categories: Record<ReportCategory, string>
}

export function submitReport(input: {
  target: ReportTarget
  category: ReportCategory
  detail: string
  contact?: string
}): Promise<{ ok: boolean; id: string; duplicate: boolean }> {
  return request('/api/reports', { method: 'POST', body: JSON.stringify(input) })
}

export function listReports(status: 'open' | 'dismissed' | 'takedown' | 'all' = 'open'): Promise<ReportQueue> {
  return request<ReportQueue>('/api/admin/reports?status=' + status)
}

export function resolveReport(id: string, action: 'dismiss' | 'takedown', note: string): Promise<{ ok: boolean; report: ReportItem; takedown: { templateId: string; title: string } | null }> {
  return request('/api/admin/reports/' + id + '/resolve', {
    method: 'POST',
    body: JSON.stringify({ action, note }),
  })
}
