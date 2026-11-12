// 评审队列：哪几条作品还等着人动手。
// 口径与状态胶囊一致——只看当前这一版；最近一次结论是「需人工确认」或「不通过」的才算等你改。
// 「通过」不进队列：它已经不需要动手了；新开的版本还没评过也不进：它连意见都还没有。
// 工作台的「下一步」与「评审等你看的」都读这一处，不各自去猜。
//
// v0.9.20 起队列有出口：人看过、这一版先不改的可以「已看过」，它从待办挪到 seen，
// 但结论不动、胶囊不动——看过的评审还在评审历史里，「看过」不等于「改过」。
import { listProjects, getProject } from './projects.mjs'
import { reviewCountsByProject } from './reviews.mjs'
import { reviewsForVersion, projectStatus } from './project-status.mjs'
import { listAcks } from './review-acks.mjs'

/**
 * 一条作品当前是否还等着人动手：是就返回队列行，不是就 null。
 * 不看「已看过」——那是队列自己的事；接口 POST /api/reviews/ack 也用它，保证两边口径一样。
 */
export function pendingRow(project, counts) {
  // 已交付的不用再催：都交出去了，评审意见留作记录
  if (!project || project.status === 'done') return null
  const current = reviewsForVersion(counts?.[project.id]?.versions || {}, project.version)
  if (!current.count) return null
  if (current.lastVerdict !== 'needs_review' && current.lastVerdict !== 'fail') return null
  return {
    projectId: project.id,
    title: project.title,
    // 第几版：意见是评在哪一版上的，卡片与作品页对得上
    version: project.version,
    verdict: current.lastVerdict,
    at: current.lastAt,
    count: current.count,
    status: projectStatus(project, current),
  }
}

/** 这条作品现在等着人动手吗？给「已看过」接口用。 */
export async function reviewQueueRow(projectId, user = null) {
  const project = await getProject(projectId, user)
  if (!project) return null
  return pendingRow(project, await reviewCountsByProject(user))
}

/**
 * 队列：items 是还没看的，seen 是看过了、这一版先不改的。
 * 一条「已看过」只在版次与评审时间都对得上时才算数——同一版又评出新结论会自动回到 items。
 */
export async function reviewQueue(user = null, { limit = 6 } = {}) {
  const [projects, counts, acks] = await Promise.all([listProjects(user), reviewCountsByProject(user), listAcks(user)])
  const acked = new Map(acks.map((entry) => [entry.projectId, entry]))
  const rows = []
  const seen = []
  for (const project of projects) {
    const row = pendingRow(project, counts)
    if (!row) continue
    const ack = acked.get(row.projectId)
    if (ack && ack.version === row.version && ack.reviewAt === row.at) {
      seen.push({ ...row, seenAt: ack.at })
    } else {
      rows.push(row)
    }
  }
  // 越新越靠前：刚评出意见的那条最该先看
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.projectId.localeCompare(b.projectId))
  seen.sort((a, b) => String(b.seenAt).localeCompare(String(a.seenAt)) || a.projectId.localeCompare(b.projectId))
  const max = Math.min(20, Math.max(1, Math.round(Number(limit) || 6)))
  return {
    items: rows.slice(0, max),
    total: rows.length,
    // 看过的只需给界面写一行「已看过 N 条」与撤销，最多 10 条够用
    seen: seen.slice(0, 10),
    seenTotal: seen.length,
  }
}
