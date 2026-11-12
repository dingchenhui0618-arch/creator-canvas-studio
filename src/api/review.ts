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

export type ReviewSummary = {
  id: string
  intent: string
  /** 从作品页发起的评审会带作品 id；普通评审为空 */
  projectId?: string
  verdict: 'pass' | 'needs_review' | 'fail' | ''
  summary: string
  observations: number
  source: { kind?: string; label?: string; media?: string; imageUrl?: string }
  ms: number
  credits: { cost: number; balance: number | null } | null
  createdAt: string
}

export type ReviewRecord = ReviewSummary & { result: ReviewResult }

export const listReviews = (limit = 10, projectId = '') =>
  request<{ items: ReviewSummary[]; total: number }>(
    '/api/reviews?limit=' + limit + (projectId ? '&projectId=' + encodeURIComponent(projectId) : ''),
  )

export const getReview = (id: string) => request<ReviewRecord>('/api/reviews/' + id)
