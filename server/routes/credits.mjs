// /api/credits：当前账号的积分余额、单价、近期流水。
// 单价只是「内部积分」，不是钱；充值通道仍未接入（GET /api/billing/overview 仍是未开通占位）。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { creditsFor } from '../credits.mjs'

export function createCreditsRouter() {
  return {
    prefix: '/api/credits',
    async handle(req, res, url, pathname) {
      if (pathname !== '/api/credits') return false
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '只支持 GET' })
        return true
      }
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }
      const limit = Number(url.searchParams.get('limit') || 20)
      sendJson(res, 200, creditsFor(user, limit))
      return true
    },
  }
}
