// /api/billing/*：充值（v0.9.162 起能真的到账，但仍然没有支付渠道）。
// 三条约定：
//   - overview 只回档位、积分口径与当前模式，余额不在这里伪造（真余额在 /api/credits）；
//   - POST /orders 登录后选一档：按档位落一条订单，同时把积分记进账本（kind = recharge）；
//   - VQ_BILLING_MODE=off 时退回旧行为：501 BILLING_NOT_CONFIGURED，用户只能提交申请由管理员发放。
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { grant } from '../credits.mjs'
import { logEvent } from '../log.mjs'
import { planById, publicPlans } from '../plans.mjs'
import { addOrder, listOrders, orderCount } from '../billing-orders.mjs'
import { readBody, sendJson } from './_shared.mjs'

const PREFIX = '/api/billing'

function overviewMessage(plans, auto) {
  if (!plans.length) return '计费方式与价格还没定：暂时没有可选的档位，也不会产生任何扣费。'
  if (!auto) return '支付通道还没接入：选一档提交开通申请，管理员确认收款后把积分放到账号里。'
  return '支付通道还没接入（商户号还没下来），现在是内测直充：选一档直接到账，不会扣任何真实款项；上线后换成扫码支付。'
}

export function billingOverview(mode = config.billing.mode) {
  const plans = publicPlans()
  const auto = mode !== 'off'
  return {
    ok: true,
    // 能不能自助到账：既要模式开着，也要后台真的配了档位
    enabled: auto && plans.length > 0,
    currency: 'CNY',
    // 积分口径（唯一真源在服务端配置）：界面与画布都按它把「元」换算成积分
    pointsPerCny: config.credits.pointsPerCny,
    unit: config.credits.unit,
    mode: auto ? 'auto' : 'off',
    provider: auto ? 'internal' : null,
    plans,
    balance: { credits: null, unit: config.credits.unit, updatedAt: null },
    message: overviewMessage(plans, auto),
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
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        // 只列自己的订单：别人的充值记录不该出现在这一屏
        sendJson(res, 200, { items: listOrders({ userId: user.id, limit: 20 }), total: orderCount(user.id) })
        return true
      }

      if (rest === 'orders' && req.method === 'POST') {
        const user = currentUser(req)
        if (!user) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        const body = await readBody(req)
        if (!body.planId) {
          sendJson(res, 400, { error: '缺少 planId', code: 'PLAN_REQUIRED' })
          return true
        }
        const plan = planById(String(body.planId))
        if (!plan || !plan.enabled) {
          sendJson(res, 404, { error: '这个档位不存在或已停用，刷新后再看', code: 'PLAN_NOT_FOUND' })
          return true
        }
        if (config.billing.mode === 'off') {
          sendJson(res, 501, {
            ok: false,
            code: 'BILLING_NOT_CONFIGURED',
            error: '充值通道尚未接入，无法创建订单。',
          })
          return true
        }
        // 积分与金额一律按档位算：客户端传多少都不作数
        const order = addOrder({ userId: user.id, plan, channel: 'internal', status: 'paid' })
        const granted = grant(user.id, plan.credits, { kind: 'recharge', note: '充值 · ' + plan.name + ' · ' + order.id })
        logEvent('billing-recharge', {
          user: user.email,
          plan: plan.id,
          credits: plan.credits,
          priceCents: plan.priceCents,
          order: order.id,
          balance: granted.balance,
        })
        sendJson(res, 201, {
          ok: true,
          order,
          credits: plan.credits,
          balance: granted.balance,
          unit: config.credits.unit,
        })
        return true
      }

      sendJson(res, 404, { error: '未知的充值接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
