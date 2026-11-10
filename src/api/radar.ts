import type { MediaItem, ReplicaTemplate, ReplicateJob, SearchResult, TemplateList } from '../domain/radar'

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

export function searchMedia(params: { platform: string; q: string; start?: string; end?: string }) {
  const query = new URLSearchParams({ platform: params.platform, q: params.q })
  if (params.start) query.set('start', params.start)
  if (params.end) query.set('end', params.end)
  return request<SearchResult>('/api/search?' + query.toString())
}

export const startReplicate = (item: MediaItem, url: string) =>
  request<{ jobId: string }>('/api/replicate', { method: 'POST', body: JSON.stringify({ item, url }) })

export const getJob = (id: string) => request<ReplicateJob>('/api/jobs/' + id)

export function listTemplates(params: { q?: string; type?: string } = {}) {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.type) query.set('type', params.type)
  return request<TemplateList>('/api/templates?' + query.toString())
}

// 只在雷达里点「加入模板库」时才落库：只存链接与互动数据，不下载视频、不抽帧
export const saveTemplate = (item: MediaItem) =>
  request<{ template: ReplicaTemplate; created: boolean; total: number; parsed: number; saved: number }>(
    '/api/templates/from-radar',
    { method: 'POST', body: JSON.stringify({ item }) },
  )

export const getTemplate = (id: string) => request<ReplicaTemplate>('/api/templates/' + id)
export const reuseTemplate = (id: string) => request<ReplicaTemplate>('/api/templates/' + id + '/reuse', { method: 'POST' })
export const deleteTemplate = (id: string) => request<{ ok: boolean }>('/api/templates/' + id, { method: 'DELETE' })

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
