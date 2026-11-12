import type { MediaItem, ReplicaTemplate, ReplicateJob, SearchHistoryEntry, SearchResult, SharedTemplate, TemplateList } from '../domain/radar'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  const text = await response.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!response.ok) {
    const message = (json as { error?: string } | null)?.error || ('请求失败 HTTP ' + response.status)
    throw new Error(message)
  }
  return json as T
}

export const getHealth = () => request<{ ok: boolean; redfox: boolean; vision: boolean; visionModel: string; templates: number }>('/api/health')

export function searchMedia(params: { platform: string; q: string; start?: string; end?: string; page?: number; sort?: string; range?: string }) {
  const query = new URLSearchParams({ platform: params.platform, q: params.q })
  if (params.start) query.set('start', params.start)
  if (params.end) query.set('end', params.end)
  if (params.page && params.page > 1) query.set('page', String(params.page))
  if (params.sort) query.set('sort', params.sort)
  // range 是「近 7/30 天」的档位本身：历史要记它，才能原样填回表单
  if (params.range) query.set('range', params.range)
  return request<SearchResult>('/api/search?' + query.toString())
}

export const listSearchHistory = () => request<{ items: SearchHistoryEntry[] }>('/api/search/history')
export const toggleSearchFavorite = (id: string) =>
  request<{ entry: SearchHistoryEntry }>('/api/search/history/' + id + '/favorite', { method: 'POST' })
export const clearSearchHistory = () => request<{ ok: boolean; removed: number }>('/api/search/history', { method: 'DELETE' })

export const startReplicate = (item: MediaItem, url: string) =>
  request<{ jobId: string; credits?: { cost: number; balance: number | null } }>('/api/replicate', { method: 'POST', body: JSON.stringify({ item, url }) })

export const getJob = (id: string) => request<ReplicateJob>('/api/jobs/' + id)

export function listTemplates(params: { q?: string; type?: string; source?: string } = {}) {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.type) query.set('type', params.type)
  // 来源是第二排筛选（v0.9.33）：服务端只认 TEMPLATE_SOURCES 里的 key，写错会回 400 而不是静默回全库
  if (params.source) query.set('source', params.source)
  return request<TemplateList>('/api/templates?' + query.toString())
}

// 只在雷达里点「加入模板库」时才落库：只存链接与互动数据，不下载视频、不抽帧
export const saveTemplate = (item: MediaItem) =>
  request<{ template: ReplicaTemplate; created: boolean; total: number; parsed: number; saved: number }>(
    '/api/templates/from-radar',
    { method: 'POST', body: JSON.stringify({ item }) },
  )

export const getTemplate = (id: string) => request<ReplicaTemplate>('/api/templates/' + id)

// 套用模板会真的生成一张画布草稿（输入节点 + 复刻脚本节点），而不是只加复用次数
export const applyTemplate = (id: string) =>
  request<{ ok: boolean; flow: { id: string; name: string }; template: ReplicaTemplate }>('/api/templates/' + id + '/apply', {
    method: 'POST',
    body: JSON.stringify({}),
  })
export const reuseTemplate = (id: string) => request<ReplicaTemplate>('/api/templates/' + id + '/reuse', { method: 'POST' })
// 改编：以这条为底存成我的一版（新模板，原条目不动）
export const adaptTemplate = (
  id: string,
  payload: { title: string; hook: string; structure: unknown[]; storyboard: unknown[] },
) => request<{ ok: boolean; template: ReplicaTemplate }>('/api/templates/' + id + '/adapt', { method: 'POST', body: JSON.stringify(payload) })
export const deleteTemplate = (id: string) => request<{ ok: boolean; trashed?: boolean }>('/api/templates/' + id, { method: 'DELETE' })
export const listTemplateTrash = () => request<{ items: ReplicaTemplate[]; days: number }>('/api/templates/trash')
export const restoreTemplate = (id: string) =>
  request<{ ok: boolean; template: ReplicaTemplate }>('/api/templates/' + id + '/restore', { method: 'POST' })
export const purgeTemplate = (id: string) => request<{ ok: boolean }>('/api/templates/' + id + '/purge', { method: 'POST' })

// 只读分享：管理端（带登录态）开/停，公开端（不带登录态）读
export const createTemplateShare = (id: string) =>
  request<{ ok: boolean; token: string; createdAt: string }>('/api/templates/' + id + '/share', { method: 'POST' })
export const revokeTemplateShare = (id: string) =>
  request<{ ok: boolean }>('/api/templates/' + id + '/share', { method: 'DELETE' })
export const getSharedTemplate = (token: string) =>
  request<{ template: SharedTemplate; sharedAt: string }>('/api/share/' + encodeURIComponent(token))

export function formatCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 100000000) return (value / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
  if (value >= 10000) return (value / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return String(value)
}

export function formatDuration(seconds: number | null | undefined) {
  if (!seconds || seconds <= 0) return '--'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes ? minutes + ':' + String(rest).padStart(2, '0') : '0:' + String(rest).padStart(2, '0')
}

export const coverSrc = (url: string) => (url ? '/api/cover?url=' + encodeURIComponent(url) : '')
