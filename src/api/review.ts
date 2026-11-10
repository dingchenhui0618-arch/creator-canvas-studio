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
}

export type ReviewStatus = {
  service: boolean
  serviceUrl: string
  model: boolean
  profiles: string[]
}

export function getReviewStatus() {
  return request<ReviewStatus>('/api/review/health')
}

export function runReview(payload: { media?: string; imageUrl?: string; intent?: string; label?: string }) {
  return request<ReviewResult>('/api/review', { method: 'POST', body: JSON.stringify(payload) })
}

export type ReviewSummary = {
  id: string
  intent: string
  verdict: 'pass' | 'needs_review' | 'fail' | ''
  summary: string
  observations: number
  source: { kind?: string; label?: string; media?: string; imageUrl?: string }
  ms: number
  credits: { cost: number; balance: number | null } | null
  createdAt: string
}

export type ReviewRecord = ReviewSummary & { result: ReviewResult }

export const listReviews = (limit = 10) => request<{ items: ReviewSummary[]; total: number }>('/api/reviews?limit=' + limit)

export const getReview = (id: string) => request<ReviewRecord>('/api/reviews/' + id)
