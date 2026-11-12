import { request } from './client'

/**
 * 待办变了（评出新结论、看过、撤销、拍板）：外壳的「等你看」角标要马上跟着变，
 * 不等下一次换页。事件很小，只带「变了」这件事，数字仍由服务端算。
 */
export function noteReviewQueueChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('vq:queue-changed'))
}


export type ReviewObservation = {
  id: string
  dimension: string
  severity: 'blocker' | 'major' | 'minor' | 'info'
  statement: string
  evidence: { x: number; y: number; w: number; h: number } | null
  confidence: number
}

export type ReviewFix = { title: string; detail: string }

export type JudgeVerdictSupport = {
  choice: 'supported' | 'too_strict' | 'too_lenient' | string
  confidence: number | null
  probabilities: Record<string, number> | null
}

/** 判断模型（TypeSafe / Jev）对这份评审的再判断：只作为依据展示，不改结论。 */
export type JudgeResult =
  | {
      status: 'ok'
      model: string
      provider: string
      ms: number
      usage?: { input_tokens?: number; output_tokens?: number } | null
      /** 结论是否都有画面依据：概率 0–1 */
      evidenceConsistent: number | null
      verdictSupport: JudgeVerdictSupport | null
      /** 修正建议是否可直接执行：概率 0–1 */
      actionable: number | null
      publishRisk: {
        score: number
        confidence: number | null
        legend: Record<string, string> | null
        probabilities: Record<string, number> | null
      } | null
    }
  | { status: 'disabled'; note: string }
  | { status: 'failed'; error: string; ms: number }

export type ReviewResult = {
  requestId: string
  reviewId?: string
  credits?: { cost: number; balance: number | null }
  provider: string
  profile: string
  verdict: 'pass' | 'needs_review' | 'fail'
  summary: string
  observations: ReviewObservation[]
  fixes: ReviewFix[]
  notAssessable: string[]
  ms: number
  mode: 'service' | 'local-model' | 'unavailable'
  note: string
  /** 判断层结果：未启用 / 成功 / 失败三种状态都有，界面按状态显示 */
  judge?: JudgeResult
}

export type ReviewStatus = {
  service: boolean
  serviceUrl: string
  model: boolean
  profiles: string[]
  judge?: { configured: boolean; provider: string; model: string }
}

export function getReviewStatus() {
  return request<ReviewStatus>('/api/review/health')
}

export async function runReview(payload: { media?: string; imageUrl?: string; intent?: string; label?: string; projectId?: string }) {
  const result = await request<ReviewResult>('/api/review', { method: 'POST', body: JSON.stringify(payload) })
  // 评出新结论就可能新增或清掉一条待办（通过的那一版不再等你看）
  if (payload.projectId) noteReviewQueueChanged()
  return result
}

/** 评审记在哪条作品上：只带 id 与标题，版次在评审记录自己的 version 里。 */
export type ReviewProjectRef = { id: string; title: string }

export type ReviewSummary = {
  id: string
  intent: string
  /** 从作品页发起的评审会带作品 id；普通评审为空 */
  projectId?: string
  /** 服务端现算的归属：没记入作品或作品已被删掉时是 null */
  project?: ReviewProjectRef | null
  /** 评审发生在作品的第几版；0 表示作品还没有版本划分 */
  version?: number
  verdict: 'pass' | 'needs_review' | 'fail' | ''
  summary: string
  observations: number
  source: { kind?: string; label?: string; media?: string; imageUrl?: string }
  ms: number
  credits: { cost: number; balance: number | null } | null
  createdAt: string
}

export type ReviewRecord = ReviewSummary & { result: ReviewResult }

/**
 * 评审历史一页：total 是筛选后的总数，facets 是筛选面板上的数字。
 * 结论按当前作品筛选计数、作品按当前结论筛选计数——换一个筛选，数字仍然对着真实结果。
 */
export type ReviewFacets = {
  verdicts: { pass: number; needs_review: number; fail: number; none: number }
  projects: { id: string; title: string; count: number }[]
  orphans: number
}

export type ReviewHistoryPage = {
  items: ReviewSummary[]
  total: number
  offset: number
  limit: number
  facets: ReviewFacets
}

export const listReviews = (query: { limit?: number; offset?: number; verdict?: string; projectId?: string; orphan?: boolean } = {}) => {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 20))
  if (query.offset) params.set('offset', String(query.offset))
  if (query.verdict) params.set('verdict', query.verdict)
  if (query.projectId) params.set('projectId', query.projectId)
  if (query.orphan) params.set('orphan', '1')
  return request<ReviewHistoryPage>('/api/reviews?' + params.toString())
}

export const getReview = (id: string) => request<ReviewRecord>('/api/reviews/' + id)

/**
 * 评审队列：还等你改的作品。
 * 口径在服务端一处算：只看当前这一版，最近一次结论是「需人工确认」或「不通过」的才进队列，按评审时间倒序。
 * status 是那枚状态胶囊（文案 + 语气），与作品卡片上的是同一句话。
 */
export type ReviewQueueRow = {
  projectId: string
  title: string
  version: number
  verdict: string
  at: string
  count: number
  status: { text: string; tone: string; verdict: string }
}

/** 已经看过、这一版先不改的一条：结论不变，只是从待办里挪开。 */
export type ReviewQueueSeenRow = ReviewQueueRow & { seenAt: string }

/** 人已经拍过板的一条：结论没变，但胶囊与下一步听人的。 */
export type ReviewQueueDecidedRow = ReviewQueueRow & {
  decision: 'pass' | 'reject'
  note: string
  decidedAt: string
}

/** 队列的两种找法（v0.9.25）：时间范围按那次评审的时间算，关键字只搜作品标题。 */
export type ReviewQueueRange = 'all' | '7d' | '30d'

/** 时间范围的计数按关键字算、不按当前范围算：换一个范围，另一排数字仍然是真的。 */
export type ReviewQueueFacets = { all: number; '7d': number; '30d': number }

export type ReviewQueue = {
  ok: boolean
  /** 还没看的（筛过之后的一页） */
  items: ReviewQueueRow[]
  /** 筛出来的条数；不带筛选时就是全部等你改的 */
  total: number
  /** 不带筛选的全量：界面写「筛出 2 / 全部 9 条」用得上 */
  allTotal: number
  facets: ReviewQueueFacets
  range: ReviewQueueRange
  /** 归一后的关键字：输入框里还是原始输入，空状态与计数按这一份判断 */
  query: string
  /** 不跟着筛选变的那一条（最新的待办）：工作台的「下一步」读它 */
  lead: ReviewQueueRow | null
  /** 看过了、先没改的（最多 10 条，够写一行「已看过 N 条」） */
  seen: ReviewQueueSeenRow[]
  seenTotal: number
  /** 人已经拍过板的（同样最多 10 条，工作台只写一行） */
  decided: ReviewQueueDecidedRow[]
  decidedTotal: number
}

export const listReviewQueue = (limit = 6, query: { range?: ReviewQueueRange; q?: string } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) })
  if (query.range && query.range !== 'all') params.set('range', query.range)
  if (query.q) params.set('q', query.q)
  return request<ReviewQueue>('/api/reviews/queue?' + params.toString())
}

/** 一条拍板记录：哪一版、哪一次评审、拍成什么、哪天拍的。 */
export type ReviewDecisionRow = {
  id: string
  projectId: string
  version: number
  reviewAt: string
  verdict: string
  decision: 'pass' | 'reject'
  note: string
  at: string
}

/**
 * 已看过：把这条作品从「评审等你看的」待办里拿掉。
 * 服务端只认当前这一版最近一次评审；结论、胶囊、作品状态都不动，也不扣积分。
 */
export const ackReview = async (projectId: string) => {
  const result = await request<{ ok: boolean; ack: { projectId: string; version: number; reviewAt: string; at: string } }>(
    '/api/reviews/ack',
    { method: 'POST', body: JSON.stringify({ projectId }) },
  )
  noteReviewQueueChanged()
  return result
}

/** 撤销「已看过」：它回到待办。 */
export const unackReview = async (projectId: string) => {
  const result = await request<{ ok: boolean; removed: number }>('/api/reviews/ack/' + projectId, { method: 'DELETE' })
  noteReviewQueueChanged()
  return result
}

/**
 * 人工复核：人拍板这一版「能发 / 不能发」。
 * 落库记在「哪一次评审」上（服务端现算版次与评审时间），再评出新结论要重新拍板；不扣积分。
 * 它不改评审记录本身：模型写了什么还在评审历史里，人这一层单独记。
 */
export const decideReview = async (projectId: string, decision: 'pass' | 'reject', note = '') => {
  const result = await request<{ ok: boolean; decision: ReviewDecisionRow; row: ReviewQueueRow }>('/api/reviews/decision', {
    method: 'POST',
    body: JSON.stringify({ projectId, decision, note }),
  })
  noteReviewQueueChanged()
  return result
}

/**
 * 撤销拍板。
 * 给了 reviewAt 就只拿走那一次评审的拍板（作品页的「撤销这一版」），别的版本与更早的记录留在历史里；
 * 不给就把这条作品的记录全清掉（「清空拍板记录」）。两种都会让这条回到待办。
 */
export const clearReviewDecision = async (projectId: string, reviewAt = '') => {
  const query = reviewAt ? '?reviewAt=' + encodeURIComponent(reviewAt) : ''
  const result = await request<{ ok: boolean; removed: number; scope: 'review' | 'project' }>(
    '/api/reviews/decision/' + projectId + query,
    { method: 'DELETE' },
  )
  noteReviewQueueChanged()
  return result
}
