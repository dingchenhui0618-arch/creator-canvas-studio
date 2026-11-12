import { projectStatus, type Project } from '../domain/project'

/**
 * 作品状态胶囊：待开画布 / 在做 / 已评审 / 已交付。
 * 语气只管颜色，语义由 projectStatus 决定——两个页面读同一处，不会一处写「在做」一处写「进行中」。
 */
export default function ProjectStatusPill({ project, reviewCount }: { project: Project; reviewCount: number }) {
  const status = projectStatus(project, reviewCount)
  return <span className={'vq-project-status is-' + status.tone}>{status.text}</span>
}
