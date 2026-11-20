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
  /** 工作流运行卡上的封面是图还是视频（视频用 <video preload=metadata> 出第一帧） */
  mediaKind?: '' | 'image' | 'video'
  at: number
  source: string
  detailUrl: string
  status?: string
  nodeCount?: number
  /** 工作流：最后一段输出文本的摘要；媒体：模型 id */
  summary?: string
  model?: string
  durationMs?: number
  flowId?: string
  canvasId?: string
}

/** 每一类各有多少条（r272）：先数全部再按筛选切，所以筛到某一类时也知道其他类有没有东西。 */
export type WorksCounts = { all: number; image: number; video: number; run: number; canvas: number }

export type WorksPage = { ok: true; items: WorkItem[]; total: number; cursor: string | null; counts?: WorksCounts }

/** 一页作品。kind=all 时三种来源一起按时间排；before 是上一页返回的 cursor。 */
export function listWorks(params: { kind?: string; before?: string; limit?: number } = {}): Promise<WorksPage> {
  const query = new URLSearchParams()
  if (params.kind && params.kind !== 'all') query.set('kind', params.kind)
  if (params.before) query.set('before', params.before)
  if (params.limit) query.set('limit', String(params.limit))
  const suffix = query.toString()
  return request<WorksPage>('/api/works' + (suffix ? '?' + suffix : ''))
}
