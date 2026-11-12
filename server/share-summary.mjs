// 分享汇总：工作台的「分享出去的链接」与作品列表卡片上的分享状态共用这一套算法。
//
// 一条作品可能有若干轮链接：正在分享的那条算一轮，停用的历史各算一轮。
// 汇总只回答「分享过几轮、被打开过几次、最近一次什么时候」——
// token 与记录键只留在这两个模块里，接口只回数字。
import { getShareVisits, getShareVisitsByKey } from './share-visits.mjs'

/** 各轮打开情况合成一条：次数相加，最近一次取最晚的那一轮。 */
export function mergeVisits(list) {
  const opened = list.filter((visits) => visits.opens > 0)
  const opens = list.reduce((sum, visits) => sum + visits.opens, 0)
  if (!opened.length) return { opens: 0, firstAt: '', lastAt: '', lastClient: '' }
  const firstAt = opened.map((visits) => visits.firstAt).filter(Boolean).sort()[0] || ''
  const latest = [...opened].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0]
  return { opens, firstAt, lastAt: latest.lastAt, lastClient: latest.lastClient }
}

/**
 * 一条作品一行：正在分享的那条 + 历史各轮合起来算累计。
 * projects 由调用方按归属过滤好（listProjects 的规则），这里只管合并。
 */
export async function shareRows(projects) {
  const rows = []
  for (const project of projects) {
    const rounds = []
    if (project.share) rounds.push({ token: project.share.token, live: true })
    for (const entry of project.shareHistory) rounds.push({ key: entry.key, live: false })
    if (!rounds.length) continue
    const visits = []
    for (const round of rounds) {
      visits.push(round.live ? await getShareVisits(round.token) : await getShareVisitsByKey(round.key))
    }
    rows.push({
      projectId: project.id,
      title: project.title,
      live: Boolean(project.share),
      rounds: rounds.length,
      // 历史按停用时间倒序：第一条就是最近停用的那一轮
      lastClosedAt: project.shareHistory[0]?.closedAt || '',
      visits: mergeVisits(visits),
    })
  }
  // 最近有人打开过的排前面；都没打开过的看最近停用时间，再按轮数
  rows.sort((a, b) => {
    const at = Date.parse(a.visits.lastAt) || Date.parse(a.lastClosedAt) || 0
    const bt = Date.parse(b.visits.lastAt) || Date.parse(b.lastClosedAt) || 0
    if (bt !== at) return bt - at
    return b.rounds - a.rounds
  })
  return rows
}

/**
 * 作品列表卡片只要一小条：还在不在分享、几轮、打开过几次、最近一次。
 * 不带 token、不带记录键，也不带每一轮的明细——那些只在作品页的分享面板里。
 */
export function shareBrief(row) {
  return {
    live: row.live,
    rounds: row.rounds,
    opens: row.visits.opens,
    lastAt: row.visits.lastAt,
    lastClient: row.visits.lastClient,
  }
}

/** 按作品 id 索引：列表每一项挂自己那一条；没分享过的不进这张表。 */
export async function shareBriefsByProject(projects) {
  const map = new Map()
  for (const row of await shareRows(projects)) map.set(row.projectId, shareBrief(row))
  return map
}
