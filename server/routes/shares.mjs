// /api/shares：工作台的「分享出去的链接」汇总。
//
// 一条作品一行：正在分享的那条算一轮，停用的历史各算一轮。
// 只回轮数与累计打开情况，不回 token、不回记录键；
// 谁能看这条作品，谁就能看它的汇总（归属沿用 listProjects 的同一套规则）。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { listProjects } from '../projects.mjs'
import { shareRows } from '../share-summary.mjs'

// 工作台是「下一步点哪里」，不是报表：只列最近活跃的 6 条作品
const MAX_ROWS = 6

export function createSharesRouter() {
  return {
    prefix: '/api/shares',
    async handle(req, res, url, pathname) {
      if (pathname !== '/api/shares' || req.method !== 'GET') return false
      const rows = await shareRows(await listProjects(currentUser(req)))
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
