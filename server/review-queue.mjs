// 评审队列：哪几条作品还等着人动手。
// 口径与状态胶囊一致——只看当前这一版；最近一次结论是「需人工确认」或「不通过」的才算等你改。
// 「通过」不进队列：它已经不需要动手了；新开的版本还没评过也不进：它连意见都还没有。
// 工作台的「下一步」与「评审等你看的」都读这一处，不各自去猜。
//
// v0.9.20 起队列有出口：人看过、这一版先不改的可以「已看过」，它从待办挪到 seen，
// 但结论不动、胶囊不动——看过的评审还在评审历史里，「看过」不等于「改过」。
//
// v0.9.21 起有第三个出口：人看过证据后拍板（通过 / 不通过）。拍过板的那一条从待办挪到 decided，
// 状态胶囊改成「评审 · 人工通过 / 人工不通过」，下一步跟着换成交付或继续改。
// 拍板按「哪一次评审」认：再评出新结论，时间对不上，它回到 items——人拍的是那一次，不是永远。
//
// v0.9.25 起队列能找：按「那次评审的时间」限范围、按作品标题搜关键字。
// 都在服务端算——一屏只取 20 条，前端只筛这 20 条会把「只列了最近 20 条」变成假话；
// 计数与筛选用同一份列表算，界面上的数字才不会和真正点出来的行对不上（与作品列表 v0.9.23 同一套）。
//
// v0.9.27 起队列翻得完：一页仍是 20 条，但多了 offset——工作台点「再看 7 条」就接着往下取。
// 之前第 21 条以后只剩一句「只列了最近 20 条，还有 N 条更早的等你改」，点不动；
// 现在每一页都如实写「已列 20 / 27 条」，翻到底才说「27 条都列出来了」。
import { listProjects, getProject } from './projects.mjs'
import { reviewCountsByProject } from './reviews.mjs'
import { reviewsForVersion, projectStatus, decisionFor, deliveredCurrent } from './project-status.mjs'
import { listAcks } from './review-acks.mjs'
import { listDecisions } from './review-decisions.mjs'
// 关键字的分词只有一份：作品列表（v0.9.23）怎么切，这里就怎么切
import { projectSearchTokens } from './project-list.mjs'

/** 三种时间范围：全部 / 最近 7 天 / 最近 30 天。按那次评审的时间算，不按作品更新时间。 */
export const QUEUE_RANGES = ['all', '7d', '30d']
const RANGE_DAYS = { all: 0, '7d': 7, '30d': 30 }

/** 某个范围从哪一刻算起（ISO 串）；「全部」返回空串，表示不设下限。 */
export function queueRangeSince(range, now = Date.now()) {
  const days = RANGE_DAYS[range] || 0
  if (!days) return ''
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * 一条作品当前是否还等着人动手：是就返回队列行，不是就 null。
 * 不看「已看过」——那是队列自己的事；接口 POST /api/reviews/ack 也用它，保证两边口径一样。
 */
export function pendingRow(project, counts) {
  // 已交付的不用再催：都交出去了，评审意见留作记录。
  // 只看「这一版交没交」：交付了 v2 之后开的 v3 还没交，它照旧进待办。
  if (!project || deliveredCurrent(project)) return null
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
export async function reviewQueue(user = null, { limit = 6, offset = 0, range = 'all', q = '' } = {}) {
  const [projects, counts, acks, decisions] = await Promise.all([
    listProjects(user),
    reviewCountsByProject(user),
    listAcks(user),
    listDecisions(user),
  ])
  const acked = new Map(acks.map((entry) => [entry.projectId, entry]))
  const byProject = new Map()
  for (const entry of decisions) {
    const bucket = byProject.get(entry.projectId)
    if (bucket) bucket.push(entry)
    else byProject.set(entry.projectId, [entry])
  }
  const rows = []
  const seen = []
  const decided = []
  for (const project of projects) {
    const row = pendingRow(project, counts)
    if (!row) continue
    const decision = decisionFor(byProject.get(row.projectId), row.at)
    if (decision) {
      decided.push({ ...row, decision: decision.decision, note: decision.note, decidedAt: decision.at })
      continue
    }
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
  decided.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)) || a.projectId.localeCompare(b.projectId))
  // 关键字只搜这一行上看得见的作品标题：搜不到的东西不假装能搜到（与作品列表同一套分词，空格是「都要命中」）
  const tokens = projectSearchTokens(q)
  const keywordRows = tokens.length
    ? rows.filter((row) => {
        const text = String(row.title || '').toLowerCase()
        return tokens.every((token) => text.includes(token))
      })
    : rows
  // 换一个时间范围，另一排数字仍然是真的：计数按关键字算、不按当前范围算
  const now = Date.now()
  const since7 = queueRangeSince('7d', now)
  const since30 = queueRangeSince('30d', now)
  const facets = { all: keywordRows.length, '7d': 0, '30d': 0 }
  for (const row of keywordRows) {
    if (String(row.at) >= since7) facets['7d'] += 1
    if (String(row.at) >= since30) facets['30d'] += 1
  }
  const wanted = QUEUE_RANGES.includes(range) ? range : 'all'
  const matched = wanted === 'all' ? keywordRows : keywordRows.filter((row) => String(row.at) >= queueRangeSince(wanted, now))
  const max = Math.min(20, Math.max(1, Math.round(Number(limit) || 6)))
  // 从第几条开始取：非法值当 0、负数不往回排；越过总数就是空的一页，界面据此收起「再看」
  const from = Math.min(matched.length, Math.max(0, Math.round(Number(offset) || 0)))
  const items = matched.slice(from, from + max)
  return {
    items,
    // 筛出来的条数；不带筛选时就是全部等你改的
    total: matched.length,
    // 不带筛选的全量：界面写「筛出 2 / 全部 9 条」用得上
    allTotal: rows.length,
    facets,
    range: wanted,
    // 归一后的关键字回给界面：输入框里还是原始输入，空状态与计数按这一份判断
    query: tokens.join(' '),
    // 这一页从第几条开始、后面还有没有：界面据此写「已列 20 / 27 条」与「再看 7 条」
    offset: from,
    hasMore: from + items.length < matched.length,
    // 不跟着筛选变的那一条（最新的待办）：工作台的「下一步」读它，筛列表不会把主卡换掉
    lead: rows[0] || null,
    // 看过的只需给界面写一行「已看过 N 条」与撤销，最多 10 条够用
    seen: seen.slice(0, 10),
    seenTotal: seen.length,
    // 拍过板的同理：工作台只写一行「你拍板过 N 条」，撤销在作品页
    decided: decided.slice(0, 10),
    decidedTotal: decided.length,
  }
}
