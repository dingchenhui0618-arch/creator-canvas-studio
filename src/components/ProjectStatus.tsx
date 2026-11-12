import { projectStatus, type Project, type ProjectReviews } from '../domain/project'
import { REVIEW_VERDICT_LABEL, reviewTimeLabel } from '../domain/review'

/**
 * 作品状态胶囊：待开画布 / 在做 / 评审 · 通过 / 评审 · 需人工确认 / 评审 · 不通过 / 已交付。
 * 语气只管颜色，语义由 projectStatus 决定——列表页、作品页、工作台读同一处，不会一处写「已评审」一处写「进行中」。
 * 悬停时补一句「哪一次评审这么说」：胶囊只有几个字，说不清具体时间，但把鼠标放上去要能问出所以然。
 */
export default function ProjectStatusPill({ project, reviews }: { project: Project; reviews: ProjectReviews }) {
  const status = projectStatus(project, reviews)
  const note = status.verdict
    ? REVIEW_VERDICT_LABEL[status.verdict] + ' · ' + reviewTimeLabel(reviews.lastAt) + ' · 评过 ' + reviews.count + ' 次'
    : undefined
  return (
    <span className={'vq-project-status is-' + status.tone} title={note}>
      {status.text}
    </span>
  )
}
