import type { ReviewIssues, ReviewProjectRef, ReviewSummary } from '../api/review'
import type { ProjectDeliveryReview } from './project'

/** 结论只有三种口径，全站一处：胶囊、筛选、分享纸都从这里取字。 */
export const REVIEW_VERDICT_LABEL: Record<string, string> = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }

/** 评审历史里的时间：只到分钟，年份不重复写（列表按时间倒序） */
export function reviewTimeLabel(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

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
/** 严重度四级：评审页、版本对照、交付纸与提示词同一套字，顺序从重到轻。 */
export const ISSUE_LEVELS = ['blocker', 'major', 'minor', 'info'] as const
export type IssueLevel = (typeof ISSUE_LEVELS)[number]
export const ISSUE_LABEL: Record<IssueLevel, string> = { blocker: '阻塞', major: '主要', minor: '次要', info: '信息' }
/** 严重度只借标签的语气色，不是结论：阻塞红、主要黄，次要与信息留灰色 */
export const ISSUE_TONE: Record<IssueLevel, 'fail' | 'warn' | 'plain'> = { blocker: 'fail', major: 'warn', minor: 'plain', info: 'plain' }

/**
 * 这次评审里有几条记了严重度。
 * 0 不等于「没有问题」——老记录没有 severity 字段，那时一个都不能算，
 * 界面据此不写「0 个阻塞」，改说「没记严重度」。
 */
export function issueCount(issues?: ReviewIssues | null): number {
  const counted = Math.round(Number(issues?.counted) || 0)
  return counted > 0 ? counted : 0
}

/**
 * 从一次评审的 observations 现数一遍（评审结果页用；服务端存的是同一套数字）。
 * 认不出的 severity 不计入 counted——老记录因此不会被写成「0 个阻塞」。
 */
export function issueCountsOf(observations?: { severity?: string }[] | null): ReviewIssues {
  const list = Array.isArray(observations) ? observations : []
  const counts: ReviewIssues = { blocker: 0, major: 0, minor: 0, info: 0, counted: 0, observations: list.length }
  for (const item of list) {
    const level = String(item?.severity || '').toLowerCase() as IssueLevel
    if (!ISSUE_LEVELS.includes(level)) continue
    counts[level] += 1
    counts.counted += 1
  }
  return counts
}

/** 「1 阻塞 · 2 主要」：只列非零项，从重到轻；没记严重度时回空串。 */
export function issueLine(issues?: ReviewIssues | null): string {
  if (!issues || issueCount(issues) === 0) return ''
  return ISSUE_LEVELS
    .filter((level) => Math.round(Number(issues[level]) || 0) > 0)
    .map((level) => Math.round(Number(issues[level]) || 0) + ' ' + ISSUE_LABEL[level])
    .join(' · ')
}

/**
 * 「交时评审」的一句话，三种状态必须分开写（v0.9.85）：
 *   有快照 = 交的时候评成什么；null = 当时查过，还没评过；没有字段 = 升级前的交付记录，当时没记。
 * 老记录不能拿这一版后来的评审冒充——交付之后再重评，历史不该被改写。
 */
export function deliveryReviewText(review: ProjectDeliveryReview | null | undefined): string {
  if (review && typeof review === 'object') {
    const verdict = REVIEW_VERDICT_LABEL[review.verdict] || '未记结论'
    const line = issueLine(review.issues)
    const gap = issueGap(review.issues)
    return verdict + (line ? ' · ' + line : '') + (gap ? ' · 另有 ' + gap + ' 条没记严重度' : '')
  }
  if (review === null) return '还没评过'
  return '没记（升级前的交付记录）'
}

/** 有几条问题没记严重度：老记录才会出现，写出来比藏起来诚实。 */
export function issueGap(issues?: ReviewIssues | null): number {
  if (!issues) return 0
  const total = Math.max(0, Math.round(Number(issues.observations) || 0))
  return Math.max(0, total - issueCount(issues))
}

/**
 * 这一版比上一版多了还是少了问题。
 * 只比前三档（阻塞 / 主要 / 次要），从重到轻取第一个有变化的——一次只说一件事，不堆一堆数字。
 * 信息级不参与：它本来就是「看到但不确定算不算问题」。
 * 任何一边没记严重度就不比（老记录比不了），回 null，界面不写。
 */
export function issueCompare(
  prev?: ReviewIssues | null,
  cur?: ReviewIssues | null,
): { level: 'blocker' | 'major' | 'minor'; delta: number; tone: 'better' | 'worse' } | null {
  if (!prev || !cur) return null
  if (issueCount(prev) === 0 || issueCount(cur) === 0) return null
  for (const level of ['blocker', 'major', 'minor'] as const) {
    const delta = Math.round(Number(cur[level]) || 0) - Math.round(Number(prev[level]) || 0)
    if (delta === 0) continue
    return { level, delta, tone: delta < 0 ? 'better' : 'worse' }
  }
  return null
}

/**
 * 某一版的评审，按时间倒序。
 * 版本划分之前记的评审（version 0）算进 v1——与 reviewsForVersion 的计数同一套口径，
 * 否则版本对照会写「1 次评审」却一条都列不出来。
 */
export function reviewsOfVersion(reviews: ReviewSummary[], version: number): ReviewSummary[] {
  const at = (n: number) => reviews.filter((item) => Math.max(0, Math.round(Number(item.version) || 0)) === n)
  const own = at(version)
  const legacy = version === 1 ? at(0) : []
  return [...own, ...legacy].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function reviewWorkLine(review: {
  project?: ReviewProjectRef | null
  projectId?: string
  version?: number
}): string {
  if (review.project) return '作品 · ' + review.project.title + ' · ' + reviewVersionLabel(review.version)
  if (review.projectId) return '记入的作品看不到了'
  return '没记入作品'
}
