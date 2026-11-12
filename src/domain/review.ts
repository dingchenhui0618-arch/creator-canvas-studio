import type { ReviewProjectRef } from '../api/review'

/**
 * 评审记在作品的第几版，全站一处。
 * 评审记录里存的是「评审当时作品的版次」——作品后来开新版，这条评审仍然记在原来那一版。
 * 没有版次的老记录如实写「未记版次」，不冒充第 1 版。
 */
export function reviewVersionLabel(version?: number): string {
  const n = Math.round(Number(version) || 0)
  return n > 0 ? '第 ' + n + ' 版' : '未记版次'
}

/**
 * 历次评审里那一行：评审历史要能回答「这条结论记在哪条作品下」。
 * 普通评审（模板首帧、粘贴图片地址）没挂在作品上；作品被删掉后评审还在，但归属没了，
 * 这两种都写清楚，不留空白让人猜。
 */
export function reviewWorkLine(review: {
  project?: ReviewProjectRef | null
  projectId?: string
  version?: number
}): string {
  if (review.project) return '作品 · ' + review.project.title + ' · ' + reviewVersionLabel(review.version)
  if (review.projectId) return '记入的作品看不到了'
  return '没记入作品'
}
