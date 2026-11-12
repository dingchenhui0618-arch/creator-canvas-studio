// /api/deliveries：工作台的「交出去的」——跨作品把每一次交付摊成一条线。
//
// 一条记录一行：哪条作品的第几版、什么时候交的、那一版的结论、现在还作不作数。
// 只回交付记录本身与它那一版的评审计数，不带脚本、不带 token、不带交付稿全文；
// 谁能看这条作品，谁就能看它的交付记录（归属沿用 listProjects 的同一套规则）。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { listProjects } from '../projects.mjs'
import { reviewCountsByProject } from '../reviews.mjs'
import { deliveryLedger } from '../delivery-ledger.mjs'

export function createDeliveriesRouter() {
  return {
    prefix: '/api/deliveries',
    async handle(req, res, url, pathname) {
      if (pathname !== '/api/deliveries') return false
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '只读接口：取交付流水用 GET /api/deliveries' })
        return true
      }
      const user = currentUser(req)
      const [projects, counts] = await Promise.all([listProjects(user), reviewCountsByProject(user)])
      const ledger = deliveryLedger(
        { projects, counts },
        {
          // 页码由界面给：第一页 8 条，点「再看 N 条」接着往下取
          offset: url.searchParams.get('offset') || 0,
          limit: url.searchParams.get('limit') || undefined,
        },
      )
      sendJson(res, 200, ledger)
      return true
    },
  }
}
