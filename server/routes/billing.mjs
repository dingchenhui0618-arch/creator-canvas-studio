// /api/billing/*：充值通道的接口位，先把契约定下来，支付与计费还没接入。
// 规则：没接通的通道一律如实说「未开通」，不返回假余额、假订单、假价格。
import { readBody, sendJson } from './_shared.mjs'

const PREFIX = '/api/billing'

// 计费模型还没定（按次 / 按月 / 企业合同都没拍板），所以档位返回空数组，
// 界面只展示「未开通」，等定价确定后往这里加 plan 即可。
const PLANS = []

export function billingOverview() {
  return {
    ok: true,
    enabled: false,
    currency: 'CNY',
    provider: null,
    plans: PLANS,
    balance: { credits: null, unit: '次', updatedAt: null },
    message: '充值通道尚未接入：价格与支付方式还没定，当前使用不产生任何扣费。',
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
