import { projectStatus, type Project, type ProjectDecision, type ProjectReviews } from '../domain/project'
import { REVIEW_VERDICT_LABEL, reviewTimeLabel } from '../domain/review'

/**
 * 作品状态胶囊：待开画布 / 在做 / 评审 · 通过 / 评审 · 需人工确认 / 评审 · 不通过 / 评审 · 人工通过 / 评审 · 人工不通过 / 已交付。
 * 语气只管颜色，语义由 projectStatus 决定——列表页、作品页、工作台读同一处，不会一处写「已评审」一处写「进行中」。
 * 悬停时补一句「哪一次评审这么说」：人拍过板的写谁拍的、什么时候拍的，模型给的结论写结论与时间。
 */
export default function ProjectStatusPill({
  project,
  reviews,
  decision = null,
}: {
  project: Project
  reviews: ProjectReviews
  /** 管当前这一版最近一次评审的人工拍板；没有就是 null */
  decision?: ProjectDecision | null
}) {
  const status = projectStatus(project, reviews, decision)
  const note =
    status.human && decision
      ? (decision.decision === 'pass' ? '你拍板通过' : '你拍板不通过') +
        ' · ' + reviewTimeLabel(decision.at) +
        (decision.note ? ' · ' + decision.note : '')
      : status.verdict
        ? REVIEW_VERDICT_LABEL[status.verdict] + ' · ' + reviewTimeLabel(reviews.lastAt) + ' · 评过 ' + reviews.count + ' 次'
        : undefined
  return (
    <span className={'vq-project-status is-' + status.tone} title={note}>
      {status.text}
    </span>
  )
}