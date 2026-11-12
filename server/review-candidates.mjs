// 评审页从哪条作品开始：评的是「这一版的画面」，不是模板库里的某张首帧。
//
// 为什么放在服务端：哪一版评过几次、最近结论是什么、人拍过板没有、有没有画布，
// 这四件事全站只有一处口径（project-status.mjs 的 reviewsForVersion / decisionFor /
// projectStatus / deliveredCurrent）。评审页再自己算一遍，就会出现「卡片写需人工确认、
// 评审页写在做」这种自相矛盾——这正是 v0.9.19 收敛掉的东西，不能从新入口漏回来。
//
// 不塞进 /api/projects：作品列表那一份要带模板、运行次数、分享摘要，重；
// 评审页只要「选哪一条开评」，这里只回这一屏用得上的六个数。
//
// 排序按最近改动（与作品列表同一顺序）：用户刚动过哪条作品先给哪条，不按结论猜他想评什么。
// 已交付的也留着（写清「已交付」）：交付是对某一版的宣布，复核是另一件事，不替他删掉入口。
import { listProjects } from './projects.mjs'
import { reviewCountsByProject } from './reviews.mjs'
import { listDecisions } from './review-decisions.mjs'
import {
  reviewsForVersion,
  decisionFor,
  deliveredCurrent,
  projectStatus,
} from './project-status.mjs'

/** 首屏给几条：再多就变成第二个作品列表了 */
export const REVIEW_CANDIDATE_LIMIT = 4
/** 上限：给 12 条已经够一屏，别让这个接口变成翻页列表 */
export const REVIEW_CANDIDATE_MAX = 12

/**
 * 这一版叫什么。还没开画布的作品不叫「第 0 版」，照实说它还没有这一版。
 * 与作品页、画布横幅上的写法一致。
 */
export function versionLabel(version) {
  const n = Math.max(0, Math.round(Number(version) || 0))
  return n ? '第 ' + n + ' 版' : '还没开画布'
}

/**
 * 一条作品怎么排进评审候选。
 * counts 是这个作品按版本分组的评审计数（reviewCountsByProject 的值，取 .versions），
 * decisions 是这个作品名下的人工拍板记录（只管当前这一版最近一次评审的那条）。
 */
export function reviewCandidateRow(project, counts = {}, decisions = []) {
  const version = Math.max(0, Math.round(Number(project?.version) || 0))
  // 只看当前这一版：上一版的意见不是这一版的意见
  const current = reviewsForVersion(counts, version)
  // 拍板按「哪一次评审」认，与状态胶囊、交付稿同一处
  const decision = decisionFor(decisions, current.lastAt)
  return {
    projectId: String(project?.id || ''),
    title: String(project?.title || '未命名作品'),
    version,
    versionLabel: versionLabel(version),
    // 没有画布就没有「这一版」：界面据此不给「评这一版」，改给「先开画布」
    hasCanvas: Boolean(project?.flowId),
    delivered: deliveredCurrent(project),
    reviews: {
      count: current.count,
      lastVerdict: current.lastVerdict,
      lastAt: current.lastAt,
    },
    status: projectStatus(project, current, decision),
    updatedAt: String(project?.updatedAt || ''),
  }
}

/**
 * 评审候选：按最近改动倒序，limit 夹在 1..12。
 * total 是全部作品数（不受 limit 影响），界面写「还有 N 条在作品里」用得上；
 * withoutCanvas 是其中还没开画布的条数，空态与说明句读它，不另外数一遍。
 */
export function reviewCandidates(projects, countsByProject = {}, decisionsByProject = new Map(), { limit = REVIEW_CANDIDATE_LIMIT } = {}) {
  const rows = (Array.isArray(projects) ? projects : [])
    .filter(Boolean)
    .map((project) =>
      reviewCandidateRow(
        project,
        countsByProject?.[project.id]?.versions || {},
        decisionsByProject?.get?.(project.id) || [],
      ),
    )
    // 同一时刻改动的按 id 排：列表顺序不能一刷新就跳
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.projectId.localeCompare(b.projectId))
  const wanted = Math.round(Number(limit))
  const max = Math.min(REVIEW_CANDIDATE_MAX, Math.max(1, Number.isFinite(wanted) && wanted > 0 ? wanted : REVIEW_CANDIDATE_LIMIT))
  return {
    total: rows.length,
    withoutCanvas: rows.filter((row) => !row.hasCanvas).length,
    items: rows.slice(0, max),
  }
}

/** 读盘版本：归属由 listProjects 决定，这里只把它摊成评审候选。 */
export async function reviewCandidatesFor(user = null, { limit = REVIEW_CANDIDATE_LIMIT } = {}) {
  const [projects, counts, decisions] = await Promise.all([
    listProjects(user),
    reviewCountsByProject(user),
    listDecisions(user),
  ])
  // 拍板按作品分一次组：别在循环里重复过滤一遍十条记录
  const byProject = new Map()
  for (const entry of decisions) {
    const bucket = byProject.get(entry.projectId)
    if (bucket) bucket.push(entry)
    else byProject.set(entry.projectId, [entry])
  }
  return reviewCandidates(projects, counts, byProject, { limit })
}
