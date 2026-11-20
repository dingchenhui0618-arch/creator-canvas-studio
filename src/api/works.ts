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

/** 三个来源：快捷创作的图与视频、工作流的运行记录、无限画布。 */
export type WorksSource = 'media' | 'runs' | 'canvas'

/** 哪几个来源这次没读到（r284），值是给用户看的那一句；都读到了就是空对象。 */
export type WorksDegraded = Partial<Record<WorksSource, string>>

export type WorksPage = {
  ok: true
  items: WorkItem[]
  total: number
  cursor: string | null
  counts?: WorksCounts
  /** 这次一共看了多少条（三个来源各有扫描上限）：搜不到时要能说「只在最近 N 条里找过」 */
  scanned?: number
  /** 服务端认的那个关键词（截断 / 小写之后），用来确认这一页答的是不是当前这个问题 */
  q?: string
  /** 这次有来源没读到（r284）：界面不能把「读不到」画成「没有」，数字写「—」、空状态说没读到 */
  degraded?: WorksDegraded
}

/**
 * 一页作品。kind=all 时三种来源一起按时间排；before 是上一页返回的 cursor。
 * q 是搜作品（r281）：在服务端已经扫进内存的那批里按关键词过滤，不打上游、不扣积分。
 */
export function listWorks(params: { kind?: string; before?: string; limit?: number; q?: string } = {}): Promise<WorksPage> {
  const query = new URLSearchParams()
  if (params.kind && params.kind !== 'all') query.set('kind', params.kind)
  if (params.before) query.set('before', params.before)
  if (params.limit) query.set('limit', String(params.limit))
  if (params.q && params.q.trim()) query.set('q', params.q.trim())
  const suffix = query.toString()
  return request<WorksPage>('/api/works' + (suffix ? '?' + suffix : ''))
}
