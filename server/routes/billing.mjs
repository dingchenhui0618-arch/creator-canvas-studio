// /api/billing/*：充值通道的接口位。支付还没接入，但「档位」从 v0.9.63 起是后台维护的数据，
// 不再是代码里的空数组——价格由人来定，代码只负责如实渲染和如实拒绝。
// 规则：没接通的通道一律如实说「未开通」，不返回假余额、假订单、假价格。
import { readBody, sendJson } from './_shared.mjs'
import { publicPlans } from '../plans.mjs'

const PREFIX = '/api/billing'

function overviewMessage(plans) {
  if (plans.length) {
    return '付款通道还没接入：在这个页面按档位提交开通申请，管理员确认收款后人工把积分放到账号里；下单接口仍然不会成功。'
  }
  return '充值通道尚未接入：价格与支付方式还没定，当前使用不产生任何扣费。'
}

export function billingOverview() {
  const plans = publicPlans()
  return {
    ok: true,
    // 支付没接，就永远是 false：界面据此把「立即购买」按钮留成不可用，只放「申请开通」
    enabled: false,
    currency: 'CNY',
    provider: null,
    plans,
    balance: { credits: null, unit: '次', updatedAt: null },
    message: overviewMessage(plans),
  }
}

export function createBillingRouter() {
  return {
    prefix: PREFIX,
    async handle(req, res, url, pathname) {
      const rest = pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')

      if (rest === 'overview' && req.method === 'GET') {
        sendJson(res, 200, billingOverview())
        return true
      }

      if (rest === 'orders' && req.method === 'GET') {
        // 订单表还没建：返回空列表而不是虚构历史
        sendJson(res, 200, { items: [], total: 0 })
        return true
      }

      if (rest === 'orders' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.planId) {
          sendJson(res, 400, { error: '缺少 planId', code: 'PLAN_REQUIRED' })
          return true
        }
        // 支付通道未接入：明确 501，不假装下单成功
        sendJson(res, 501, {
          ok: false,
          code: 'BILLING_NOT_CONFIGURED',
          error: '充值通道尚未接入，无法创建订单。',
        })
        return true
      }

      sendJson(res, 404, { error: '未知的充值接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
