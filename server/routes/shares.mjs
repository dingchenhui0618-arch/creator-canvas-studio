// /api/shares：工作台的「分享出去的链接」汇总。
//
// 一条作品一行：正在分享的那条算一轮，停用的历史各算一轮。
// 只回轮数与累计打开情况，不回 token、不回记录键；
// 谁能看这条作品，谁就能看它的汇总（归属沿用 listProjects 的同一套规则）。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { listProjects } from '../projects.mjs'
import { getShareVisits, getShareVisitsByKey } from '../share-visits.mjs'

// 工作台是「下一步点哪里」，不是报表：只列最近活跃的 6 条作品
const MAX_ROWS = 6

/** 各轮打开情况合成一条：次数相加，最近一次取最晚的那一轮。 */
function mergeVisits(list) {
  const opened = list.filter((visits) => visits.opens > 0)
  const opens = list.reduce((sum, visits) => sum + visits.opens, 0)
  if (!opened.length) return { opens: 0, firstAt: '', lastAt: '', lastClient: '' }
  const firstAt = opened.map((visits) => visits.firstAt).filter(Boolean).sort()[0] || ''
  const latest = [...opened].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0]
  return { opens, firstAt, lastAt: latest.lastAt, lastClient: latest.lastClient }
}

async function shareRows(user) {
  const projects = await listProjects(user)
  const rows = []
  for (const project of projects) {
    const rounds = []
    if (project.share) {
      rounds.push({ token: project.share.token, live: true })
    }
    for (const entry of project.shareHistory) {
      rounds.push({ key: entry.key, live: false })
    }
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

export function createSharesRouter() {
  return {
    prefix: '/api/shares',
    async handle(req, res, url, pathname) {
      if (pathname !== '/api/shares' || req.method !== 'GET') return false
      const rows = await shareRows(currentUser(req))
      sendJson(res, 200, {
        items: rows.slice(0, MAX_ROWS),
        // 超过 6 条时页面写「还有 N 条」，所以总数与总次数按全部算
        total: rows.length,
        opens: rows.reduce((sum, row) => sum + row.visits.opens, 0),
      })
      return true
    },
  }
}
