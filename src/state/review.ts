// 跨页「送去评审」：模板库/雷达点一下，切到评审页并带上对象
export type ReviewTarget = { media?: string; imageUrl?: string; label: string; intent?: string }

let pending: ReviewTarget | null = null
const EVENT = 'vq:review-target'

export function requestReview(target: ReviewTarget) {
  pending = target
  window.dispatchEvent(new CustomEvent(EVENT, { detail: target }))
  window.dispatchEvent(new CustomEvent('vq:navigate', { detail: { page: 'review' } }))
}

export function consumeReviewTarget(): ReviewTarget | null {
  const value = pending
  pending = null
  return value
}

export function onReviewRequest(handler: (target: ReviewTarget) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<ReviewTarget>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
