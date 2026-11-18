// 作品流 API：GET /api/works 一个接口，筛选与翻页都交给服务端。
import { request } from './client'

export type WorkKind = 'image' | 'video' | 'run' | 'canvas'

export type WorkItem = {
  id: string
  kind: WorkKind
  title: string
  aspect: string
  thumbUrl: string | null
  previewUrl: string | null
  at: number
  source: string
  detailUrl: string
  status?: string
  nodeCount?: number
}

export type WorksPage = { ok: true; items: WorkItem[]; total: number; cursor: string | null }

/** 一页作品。kind=all 时三种来源一起按时间排；before 是上一页返回的 cursor。 */
export function listWorks(params: { kind?: string; before?: string; limit?: number } = {}): Promise<WorksPage> {
  const query = new URLSearchParams()
  if (params.kind && params.kind !== 'all') query.set('kind', params.kind)
  if (params.before) query.set('before', params.before)
  if (params.limit) query.set('limit', String(params.limit))
  const suffix = query.toString()
  return request<WorksPage>('/api/works' + (suffix ? '?' + suffix : ''))
}
