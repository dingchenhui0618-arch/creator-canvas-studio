// /api/credits：当前账号的积分余额、单价、近期流水。
// 单价只是「内部积分」，不是钱；充值通道仍未接入（GET /api/billing/overview 仍是未开通占位）。
import { readBody, sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { creditsFor } from '../credits.mjs'
import { createRequest, pendingRequestOf } from '../credit-requests.mjs'
import { logEvent } from '../log.mjs'

export function createCreditsRouter() {
  return {
    prefix: '/api/credits',
    async handle(req, res, url, pathname) {
      // 额度申请：积分不够时用户在这里留一条，管理员后台一键发放（不做支付，定价还没定）
      if (pathname === '/api/credits/request') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        if (req.method === 'GET') {
          // 只回自己的那条：设置页据此显示「已提交，等管理员处理」
          sendJson(res, 200, { ok: true, pending: pendingRequestOf(user.id) })
          return true
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '只支持 GET / POST' })
          return true
        }
        const body = await readBody(req)
        const result = createRequest({ user, amount: body.amount, reason: body.reason })
        logEvent('credit-request', { user: user.email, amount: result.request.amount, created: result.created })
        sendJson(res, result.created ? 201 : 200, {
          ok: true,
          created: result.created,
          request: result.request,
          pending: pendingRequestOf(user.id),
        })
        return true
      }
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
      sendJson(res, 200, creditsFor(user, {
        limit: url.searchParams.get('limit') || 20,
        offset: url.searchParams.get('offset') || 0,
      }))
      return true
    },
  }
}
