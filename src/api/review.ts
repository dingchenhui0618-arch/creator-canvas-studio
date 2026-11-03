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

export function runReview(payload: { media?: string; imageUrl?: string; intent?: string }) {
  return request<ReviewResult>('/api/review', { method: 'POST', body: JSON.stringify(payload) })
}
