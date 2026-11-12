// 评审队列：哪几条作品还等着人动手。
// 口径与状态胶囊一致——只看当前这一版；最近一次结论是「需人工确认」或「不通过」的才算等你改。
// 「通过」不进队列：它已经不需要动手了；新开的版本还没评过也不进：它连意见都还没有。
// 工作台的「下一步」与「评审等你看的」都读这一处，不各自去猜。
import { listProjects } from './projects.mjs'
import { reviewCountsByProject } from './reviews.mjs'
import { reviewsForVersion, projectStatus } from './project-status.mjs'

export async function reviewQueue(user = null, { limit = 6 } = {}) {
  const [projects, counts] = await Promise.all([listProjects(user), reviewCountsByProject(user)])
  const rows = []
  for (const project of projects) {
    // 已交付的不用再催：都交出去了，评审意见留作记录
    if (project.status === 'done') continue
    const current = reviewsForVersion(counts[project.id]?.versions || {}, project.version)
    if (!current.count) continue
    if (current.lastVerdict !== 'needs_review' && current.lastVerdict !== 'fail') continue
    rows.push({
      projectId: project.id,
      title: project.title,
      // 第几版：意见是评在哪一版上的，卡片与作品页对得上
      version: project.version,
      verdict: current.lastVerdict,
      at: current.lastAt,
      count: current.count,
      status: projectStatus(project, current),
    })
  }
  // 越新越靠前：刚评出意见的那条最该先看
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.projectId.localeCompare(b.projectId))
  const max = Math.min(20, Math.max(1, Math.round(Number(limit) || 6)))
  return { items: rows.slice(0, max), total: rows.length }
}
