import { request } from './client'

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

export function runReview(payload: { media?: string; imageUrl?: string; intent?: string; label?: string; projectId?: string }) {
  return request<ReviewResult>('/api/review', { method: 'POST', body: JSON.stringify(payload) })
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

export const listReviewQueue = (limit = 6) =>
  request<{ ok: boolean; items: ReviewQueueRow[]; total: number }>('/api/reviews/queue?limit=' + limit)
