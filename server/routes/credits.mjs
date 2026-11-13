// /api/credits：当前账号的积分余额、单价、近期流水。
// 单价只是「内部积分」，不是钱；充值通道仍未接入（GET /api/billing/overview 仍是未开通占位）。
import { readBody, sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { creditsFor } from '../credits.mjs'
import { createRequest, pendingRequestOf, requestsOf } from '../credit-requests.mjs'
import { planById } from '../plans.mjs'
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
          // 只回自己的：设置页据此显示「已提交，等管理员处理」与最近几张单据
          sendJson(res, 200, { ok: true, pending: pendingRequestOf(user.id), items: requestsOf(user.id, 5) })
          return true
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '只支持 GET / POST' })
          return true
        }
        const body = await readBody(req)
        // 带 planId 时数量与价格以服务端档位为准；档位不存在就直接拒绝（不许客户端自己写价格）
        let plan = null
        if (body.planId) {
          plan = planById(body.planId)
          if (!plan || !plan.enabled) {
            sendJson(res, 404, { error: '这个档位不存在或已停用，刷新后再看' })
            return true
          }
        }
        const result = createRequest({ user, amount: body.amount, reason: body.reason, plan })
        logEvent('credit-request', {
          user: user.email,
          amount: result.request.amount,
          plan: result.request.planId || '',
          price: result.request.priceCents,
          created: result.created,
        })
        sendJson(res, result.created ? 201 : 200, {
          ok: true,
          created: result.created,
          request: result.request,
          pending: pendingRequestOf(user.id),
          items: requestsOf(user.id, 5),
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
