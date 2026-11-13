// 定价档位（v0.9.63）。这一组盯住五件事：
//   1) 价格是数据不是代码：后台增删改，公开接口按它渲染，改完下一次读就生效；
//   2) 校验在服务端：空名、0 积分、负价、超长备注、超上限都被拒绝，并给中文原因；
//   3) 付款通道没接就不装开通：overview 永远 enabled:false，下单接口 501；
//   4) 申请带档位时数量与价格由服务端决定，客户端传的 amount 不作数；
//   5) 单据是快照：档位改名、改价、删掉，已提交的申请显示的还是当时那一笔。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-plans-'))
process.env.VQ_KEY_SECRET = 'test-secret-plans'

const auth = await import('../server/auth.mjs')
const plans = await import('../server/plans.mjs')
const { listRequests, requestsOf, resolveRequest } = await import('../server/credit-requests.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')
const { createCreditsRouter } = await import('../server/routes/credits.mjs')
const { createBillingRouter, billingOverview } = await import('../server/routes/billing.mjs')

const admin = auth.createUser({ email: '[EMAIL:ADMIN1]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const buyer = auth.createUser({ email: '[EMAIL:BUYER1]', password: 'Passw0rd!demo', name: '付费用户', kind: 'user' })
const stranger = auth.createUser({ email: '[EMAIL:STRANGER1]', password: 'Passw0rd!demo', name: '路人', kind: 'user' })

const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.0.1' }).token).split(';')[0]
const buyerCookie = auth.sessionCookie(auth.createSession(buyer, { userAgent: 'test', ip: '10.0.0.2' }).token).split(';')[0]
const strangerCookie = auth.sessionCookie(auth.createSession(stranger, { userAgent: 'test', ip: '10.0.0.3' }).token).split(';')[0]

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

const call = async (router, req, pathname) => {
  const res = mockRes()
  await router.handle(req, res, new URL('http://127.0.0.1' + pathname), pathname)
  return res
}

const adminRouter = createAdminRouter()
const creditsRouter = createCreditsRouter()
const billingRouter = createBillingRouter()

test('新增档位：整数分入库、默认在售、按 sort 排序', () => {
  const first = plans.savePlan({ name: '体验档', credits: 1000, priceCents: 9900, note: '内测期成本价' }, 'admin@example.test')
  assert.equal(first.ok, true)
  assert.match(first.plan.id, /^plan_[0-9a-f]{8}$/)
  assert.equal(first.plan.priceCents, 9900)
  assert.equal(first.plan.credits, 1000)
  assert.equal(first.plan.enabled, true)
  assert.ok(first.plan.sort > 0)

  const second = plans.savePlan({ name: '标准档', credits: 5000, priceCents: 39900 }, 'admin@example.test')
  assert.equal(second.ok, true)
  const list = plans.listPlans({})
  assert.equal(list.length, 2)
  assert.ok(list[0].sort < list[1].sort, '新档位排在后面')

  // 公开形状：价格折算成元，克数不给客户端猜
  const pub = plans.publicPlans()
  assert.equal(pub[0].price, 99)
  assert.equal(pub[0].priceCents, 9900)
})

test('校验在服务端：空名、0 积分、负价、超长备注、超上限都拒绝', () => {
  assert.equal(plans.savePlan({ name: '   ', credits: 100, priceCents: 0 }).error, '档位名必填')
  assert.equal(plans.savePlan({ name: 'x'.repeat(41), credits: 100, priceCents: 0 }).error, '档位名最多 40 个字')
  assert.equal(plans.savePlan({ name: '零积分', credits: 0, priceCents: 100 }).error, '积分数量要写 1–100000 的整数')
  assert.equal(plans.savePlan({ name: '超积分', credits: 100001, priceCents: 100 }).error, '积分数量要写 1–100000 的整数')
  assert.equal(plans.savePlan({ name: '负价', credits: 10, priceCents: -1 }).error, '价格要写 0–100000 元（最多两位小数）')
  assert.equal(plans.savePlan({ name: '天价', credits: 10, priceCents: 10000001 }).error, '价格要写 0–100000 元（最多两位小数）')
  assert.equal(plans.savePlan({ name: '长备注', credits: 10, priceCents: 0, note: 'x'.repeat(121) }).error, '备注最多 120 个字')
  // 0 元档位合法：那是赠送额度，不是免费送钱
  assert.equal(plans.savePlan({ name: '赠送档', credits: 50, priceCents: 0 }).ok, true)
})

test('改价与停用：改完立刻生效，停用的不出现在公开档位里', () => {
  const target = plans.listPlans({}).find((item) => item.name === '标准档')
  const updated = plans.savePlan({ ...target, priceCents: 29900 }, 'admin@example.test')
  assert.equal(updated.ok, true)
  assert.equal(plans.planById(target.id).priceCents, 29900)
  assert.equal(plans.planById(target.id).sort, target.sort, '改价不动排序')

  const off = plans.savePlan({ ...updated.plan, enabled: false }, 'admin@example.test')
  assert.equal(off.plan.enabled, false)
  assert.equal(plans.publicPlans().some((item) => item.id === target.id), false)
  assert.equal(plans.listPlans({}).some((item) => item.id === target.id), true, '后台仍看得见停用档位')
  plans.savePlan({ ...off.plan, enabled: true }, 'admin@example.test')
})

test('overview：付款没接就永远 enabled:false，档位按后台数据渲染', () => {
  const view = billingOverview()
  assert.equal(view.enabled, false)
  assert.equal(view.provider, null)
  assert.equal(view.balance.credits, null, '余额不从充值接口伪造，真余额在 /api/credits')
  assert.ok(view.plans.length >= 2)
  assert.equal(view.plans.every((plan) => typeof plan.price === 'number' && plan.enabled === undefined), true)
  assert.match(view.message, /付款通道还没接入/)

  // 同一个 explainer 走路由也一致
  return call(billingRouter, mockReq({ cookie: buyerCookie }), '/api/billing/overview').then((res) => {
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).enabled, false)
  })
})

test('下单接口：通道没接就是 501，不生成假订单', async () => {
  const plan = plans.listPlans({})[0]
  const res = await call(billingRouter, mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: plan.id } }), '/api/billing/orders')
  assert.equal(res.statusCode, 501)
  assert.equal(JSON.parse(res.body).code, 'BILLING_NOT_CONFIGURED')
  const orders = await call(billingRouter, mockReq({ cookie: buyerCookie }), '/api/billing/orders')
  assert.deepEqual(JSON.parse(orders.body), { items: [], total: 0 })
})

test('按档位申请：积分与价格由服务端定，客户端传的 amount 不算数', async () => {
  const plan = plans.listPlans({}).find((item) => item.name === '体验档')
  const res = await call(
    creditsRouter,
    mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: plan.id, amount: 999999, reason: '想开通' } }),
    '/api/credits/request',
  )
  assert.equal(res.statusCode, 201)
  const payload = JSON.parse(res.body)
  assert.equal(payload.request.amount, plan.credits, '数量来自档位')
  assert.equal(payload.request.planId, plan.id)
  assert.equal(payload.request.planName, '体验档')
  assert.equal(payload.request.priceCents, plan.priceCents)
  assert.equal(payload.items.length, 1)

  // 同一账号只留一条待处理：重复提交返回同一条
  const again = await call(creditsRouter, mockReq({ method: 'POST', cookie: buyerCookie, body: { planId: plan.id } }), '/api/credits/request')
  assert.equal(again.statusCode, 200)
  assert.equal(JSON.parse(again.body).created, false)
  assert.equal(listRequests({ status: 'pending' }).filter((item) => item.userId === buyer.id).length, 1)
})

test('申请的档位不存在或停用：404，不落一条脏单据', async () => {
  const before = listRequests({}).length
  const missing = await call(creditsRouter, mockReq({ method: 'POST', cookie: strangerCookie, body: { planId: 'plan_ffffffff' } }), '/api/credits/request')
  assert.equal(missing.statusCode, 404)

  const plan = plans.listPlans({}).find((item) => item.name === '赠送档')
  plans.savePlan({ ...plan, enabled: false }, 'admin@example.test')
  const disabled = await call(creditsRouter, mockReq({ method: 'POST', cookie: strangerCookie, body: { planId: plan.id } }), '/api/credits/request')
  assert.equal(disabled.statusCode, 404)
  plans.savePlan({ ...plan, enabled: true }, 'admin@example.test')
  assert.equal(listRequests({}).length, before, '失败的申请不落库')
})

test('单据是快照：档位改价、改名、删掉，已提交的那张不变', () => {
  const plan = plans.listPlans({}).find((item) => item.name === '体验档')
  const mine = requestsOf(buyer.id, 5)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].planName, '体验档')
  assert.equal(mine[0].priceCents, plan.priceCents)

  plans.savePlan({ ...plan, name: '体验档（新）', priceCents: 12900 }, 'admin@example.test')
  plans.deletePlan(plan.id)
  const after = requestsOf(buyer.id, 5)[0]
  assert.equal(after.planName, '体验档')
  assert.equal(after.priceCents, plan.priceCents)
  assert.equal(plans.planById(plan.id), null)
})

test('管理员发放后单据变成「已开通」，金额记录在案', () => {
  const pending = listRequests({ status: 'pending' }).find((item) => item.userId === buyer.id)
  const resolved = resolveRequest(pending.id, { status: 'granted', by: 'admin@example.test', grantedAmount: pending.amount })
  assert.equal(resolved.status, 'granted')
  assert.equal(resolved.grantedAmount, pending.amount)
  assert.equal(requestsOf(buyer.id, 5)[0].status, 'granted')
  // 处理过的不能再发一次
  const again = resolveRequest(pending.id, { status: 'granted', by: 'admin@example.test', grantedAmount: 1 })
  assert.equal(again.grantedAmount, pending.amount)
})

test('后台路由：非管理员 403；管理员增删改查都通，坏输入 400、不存在 404', async () => {
  const denied = await call(adminRouter, mockReq({ cookie: strangerCookie }), '/api/admin/plans')
  assert.equal(denied.statusCode, 403)

  const created = await call(
    adminRouter,
    mockReq({ method: 'POST', cookie: adminCookie, body: { name: '团队档', credits: 20000, priceCents: 129900, note: '含并发' } }),
    '/api/admin/plans',
  )
  assert.equal(created.statusCode, 201)
  const plan = JSON.parse(created.body).plan

  const listed = await call(adminRouter, mockReq({ cookie: adminCookie }), '/api/admin/plans')
  assert.equal(listed.statusCode, 200)
  assert.ok(JSON.parse(listed.body).items.some((item) => item.id === plan.id))

  const bad = await call(adminRouter, mockReq({ method: 'POST', cookie: adminCookie, body: { name: '', credits: 10, priceCents: 0 } }), '/api/admin/plans')
  assert.equal(bad.statusCode, 400)

  const patched = await call(
    adminRouter,
    mockReq({ method: 'PUT', cookie: adminCookie, body: { name: '团队档', credits: 20000, priceCents: 99900 } }),
    '/api/admin/plans/' + plan.id,
  )
  assert.equal(patched.statusCode, 200)
  assert.equal(JSON.parse(patched.body).plan.priceCents, 99900)

  const unknown = await call(
    adminRouter,
    mockReq({ method: 'PUT', cookie: adminCookie, body: { name: 'x', credits: 1, priceCents: 0 } }),
    '/api/admin/plans/plan_00000000',
  )
  assert.equal(unknown.statusCode, 404)

  const removed = await call(adminRouter, mockReq({ method: 'DELETE', cookie: adminCookie }), '/api/admin/plans/' + plan.id)
  assert.equal(removed.statusCode, 200)
  assert.equal(plans.planById(plan.id), null)
  const twice = await call(adminRouter, mockReq({ method: 'DELETE', cookie: adminCookie }), '/api/admin/plans/' + plan.id)
  assert.equal(twice.statusCode, 404)
})
