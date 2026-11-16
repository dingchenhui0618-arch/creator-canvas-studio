// 充值（v0.9.162）。这一组盯住五件事：
//   1) 积分口径只有一处：1 元 = N 积分来自服务端配置，档位默认值按它现算；
//   2) 档位没人配过才铺默认三档，后台改过的一律不动；
//   3) 下单必须登录，档位必须存在且在售，积分与金额一律按档位（客户端传的不作数）；
//   4) 到账是真的：余额加、账本落一条 recharge、订单只回自己的；
//   5) 模式关掉时退回 501，不生成假订单。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-billing-'))
process.env.VQ_KEY_SECRET = 'test-secret-billing'

const auth = await import('../server/auth.mjs')
const plans = await import('../server/plans.mjs')
const orders = await import('../server/billing-orders.mjs')
const credits = await import('../server/credits.mjs')
const { config } = await import('../server/config.mjs')
const { createBillingRouter, billingOverview } = await import('../server/routes/billing.mjs')

const buyer = auth.createUser({ email: '[EMAIL:PAY1]', password: 'Passw0rd!demo', name: '充值用户', kind: 'user' })
const other = auth.createUser({ email: '[EMAIL:PAY2]', password: 'Passw0rd!demo', name: '另一个用户', kind: 'user' })
const buyerCookie = auth.sessionCookie(auth.createSession(buyer, { userAgent: 'test', ip: '10.0.1.1' }).token).split(';')[0]
const otherCookie = auth.sessionCookie(auth.createSession(other, { userAgent: 'test', ip: '10.0.1.2' }).token).split(';')[0]

function mockReq({ method = 'GET', body = null, cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      this.body += String(chunk)
      return true
    },
    end(chunk) {
      if (chunk) this.body += String(chunk)
      this.writableEnded = true
    },
  }
}

const router = createBillingRouter()
const call = async (req, pathname) => {
  const res = mockRes()
  await router.handle(req, res, new URL('http://127.0.0.1' + pathname), pathname)
  return res
}

test('积分口径只有一处：1 元 = N 积分，默认三档按它现算', () => {
  assert.equal(config.credits.pointsPerCny, 10, '默认 10 倍')
  assert.equal(plans.listPlans({}).length, 0)
  const seeded = plans.ensureDefaultPlans(config.credits.pointsPerCny)
  assert.equal(seeded, 3)
  const list = plans.listPlans({})
  assert.deepEqual(list.map((item) => item.credits), [300, 1000, 3000])
  assert.deepEqual(list.map((item) => item.priceCents), [3000, 10000, 30000])
  assert.equal(list[0].name, '体验档')
})

test('档位铺过一次就不再动：后台改过的价格不会被默认值冲掉', () => {
  assert.equal(plans.ensureDefaultPlans(10), 0)
  const target = plans.listPlans({})[0]
  plans.savePlan({ ...target, priceCents: 2500, name: '改过的档' }, '[EMAIL:ADM]')
  assert.equal(plans.ensureDefaultPlans(12), 0, '已有档位时一个都不加')
  assert.equal(plans.planById(target.id).priceCents, 2500)
  assert.equal(plans.planById(target.id).name, '改过的档')
})

test('overview 说清口径与模式，余额不在这里伪造', () => {
  const view = billingOverview()
  assert.equal(view.ok, true)
  assert.equal(view.pointsPerCny, 10)
  assert.equal(view.unit, '积分')
  assert.equal(view.mode, 'auto')
  assert.equal(view.enabled, true)
  assert.equal(view.balance.credits, null, '余额只在 /api/credits')
  assert.ok(view.plans.length >= 3)
  assert.match(view.message, /支付通道还没接入/)
  // 关掉模式：界面如实回到「只能提交申请」
  const off = billingOverview('off')
  assert.equal(off.enabled, false)
  assert.equal(off.mode, 'off')
  assert.match(off.message, /申请/)
})

test('下单要登录：匿名 401，不落订单', async () => {
  const res = await call(mockReq({ method: 'POST', body: { planId: plans.listPlans({})[0].id } }), '/api/billing/orders')
  assert.equal(res.statusCode, 401)
  assert.equal(orders.orderCount(), 0)
})

test('档位不存在或停用就 404，不落订单也不加余额', async () => {
  const before = credits.balanceOf(buyer.id)
  const missing = await call(mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: 'plan_ffffffff' } }), '/api/billing/orders')
  assert.equal(missing.statusCode, 404)

  const target = plans.listPlans({})[1]
  plans.savePlan({ ...target, enabled: false }, '[EMAIL:ADM]')
  const disabled = await call(mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: target.id } }), '/api/billing/orders')
  assert.equal(disabled.statusCode, 404)
  plans.savePlan({ ...target, enabled: true }, '[EMAIL:ADM]')

  assert.equal(credits.balanceOf(buyer.id), before)
  assert.equal(orders.orderCount(), 0)
})

test('充一档就到账：余额加、账本落 recharge、订单只回自己的', async () => {
  const plan = plans.listPlans({})[1]
  const before = credits.balanceOf(buyer.id)
  // 客户端自己写 credits 不作数
  const res = await call(
    mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: plan.id, credits: 999999 } }),
    '/api/billing/orders',
  )
  assert.equal(res.statusCode, 201)
  const payload = JSON.parse(res.body)
  assert.equal(payload.credits, plan.credits)
  assert.equal(payload.balance, before + plan.credits)
  assert.equal(credits.balanceOf(buyer.id), before + plan.credits)
  assert.equal(payload.order.channel, 'internal')

  const ledger = credits.ledgerOf(buyer.id, 5)
  assert.equal(ledger[0].kind, 'recharge')
  assert.equal(ledger[0].delta, plan.credits)
  assert.match(ledger[0].ref, /充值/)
  assert.match(ledger[0].ref, /ord_/)

  const mine = JSON.parse((await call(mockReq({ cookie: buyerCookie }), '/api/billing/orders')).body)
  assert.equal(mine.total, 1)
  assert.equal(mine.items[0].id, payload.order.id)
  assert.equal(mine.items[0].credits, plan.credits)

  // 别人的订单不该出现在这一屏
  const theirs = JSON.parse((await call(mockReq({ cookie: otherCookie }), '/api/billing/orders')).body)
  assert.equal(theirs.total, 0)
  assert.deepEqual(theirs.items, [])
})

test('模式关掉就退回 501：不生成订单、不动余额', async () => {
  const plan = plans.listPlans({})[0]
  const before = credits.balanceOf(buyer.id)
  const original = config.billing.mode
  config.billing.mode = 'off'
  try {
    const res = await call(mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: plan.id } }), '/api/billing/orders')
    assert.equal(res.statusCode, 501)
    assert.equal(JSON.parse(res.body).code, 'BILLING_NOT_CONFIGURED')
  } finally {
    config.billing.mode = original
  }
  assert.equal(credits.balanceOf(buyer.id), before)
  assert.equal(orders.orderCount(), 1, '只留上一轮那一条真订单')
})
