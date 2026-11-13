// 按次算账（v0.9.81）。这一组盯住五件事：
//   1) 汇率只有一个来源：档位（多少钱换多少积分），手填优先；没有档位就返回 none，不编一个汇率；
//   2) 每次收入 = 积分 × 汇率；一次成本 = 窗口内估算成本 ÷ 真有用量的调用数（回填条目不算分母）；
//   3) 算不出成本的行写 costKnown=false + 原因，毛利是 null——不写 0，也不给 100% 毛利率；
//   4) 不扣积分的画布出图 / 出视频单独成行：收入 0、毛利为负（倒贴），进 totals.unbilledCostMilli；
//   5) 后台接口只读：非管理员 403、汇率写坏 400、天数被夹到 90。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-pricing-'))
process.env.VQ_KEY_SECRET = 'test-secret-pricing'

const auth = await import('../server/auth.mjs')
const plans = await import('../server/plans.mjs')
const usage = await import('../server/usage-meter.mjs')
const pricing = await import('../server/pricing.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')

const admin = auth.createUser({ email: '[EMAIL:PRICING1]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const plain = auth.createUser({ email: '[EMAIL:PRICING2]', password: 'Passw0rd!demo', name: '普通账号', kind: 'user' })
const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.9.1' }).token).split(';')[0]
const plainCookie = auth.sessionCookie(auth.createSession(plain, { userAgent: 'test', ip: '10.0.9.2' }).token).split(';')[0]

// 手搓一份 usageSummary 形状的用量：纯计算不碰盘，数字好核对
function summary(byKind) {
  return { ok: true, days: 30, byKind }
}

const PLAN_LOW = { id: 'plan_low', name: '体验档', credits: 1000, priceCents: 5000, enabled: true } // ¥0.05 / 积分
const PLAN_HIGH = { id: 'plan_high', name: '专业档', credits: 500, priceCents: 5000, enabled: true } // ¥0.10 / 积分
const PLAN_FREE = { id: 'plan_free', name: '赠送档', credits: 100, priceCents: 0, enabled: true } // 不进折算
const PLAN_OFF = { id: 'plan_off', name: '停用档', credits: 10, priceCents: 1, enabled: false }

test('汇率：取最划算的档位、可按档位选、手填优先；赠送档与停用档不参与', () => {
  const auto = pricing.creditRate({ plans: [PLAN_HIGH, PLAN_FREE, PLAN_LOW, PLAN_OFF] })
  assert.equal(auto.source, 'plan')
  assert.equal(auto.planId, 'plan_low')
  assert.equal(auto.rmbPerCredit, 0.05)
  assert.equal(auto.rows.length, 2, '赠送档（价格为 0）与停用档不进折算')

  const picked = pricing.creditRate({ plans: [PLAN_HIGH, PLAN_LOW], planId: 'plan_high' })
  assert.equal(picked.planId, 'plan_high')
  assert.equal(picked.rmbPerCredit, 0.1)

  const custom = pricing.creditRate({ plans: [PLAN_LOW], rmbPerCredit: 0.02 })
  assert.equal(custom.source, 'custom')
  assert.equal(custom.rmbPerCredit, 0.02)

  const none = pricing.creditRate({ plans: [PLAN_FREE, PLAN_OFF] })
  assert.equal(none.source, 'none')
  assert.equal(none.rmbPerCredit, 0)
  assert.equal(none.rows.length, 0)
})

test('一次赚多少：收入 = 积分 × 汇率，成本按真有用量的调用摊，回填不进分母', () => {
  const result = pricing.unitEconomics({
    summary: summary([
      // 检索：2 次真调用、成本 0.30 元 → 一次 0.15；2 积分 × 0.05 = 0.10 → 倒贴 0.05（−50%）
      { kind: 'search', calls: 2, failedCalls: 0, measuredCalls: 2, tokensIn: 0, tokensOut: 0, units: 2, estCostMilli: 300 },
      // 对话：有调用但没折算金额（token 没回）→ 一次成本「未定价」，毛利 null
      { kind: 'text', calls: 1, failedCalls: 0, measuredCalls: 1, tokensIn: 0, tokensOut: 0, units: 0, estCostMilli: 0 },
      // 画布出图：2 次请求、4 张、成本 0.40 元，不扣积分
      { kind: 'image', calls: 2, failedCalls: 0, measuredCalls: 2, tokensIn: 0, tokensOut: 0, units: 4, estCostMilli: 400 },
    ]),
    plans: [PLAN_LOW],
    creditPrices: { search: 2, replicate: 10, review: 5, chat: 1, flow_run: 2 },
  })

  assert.equal(result.rate.source, 'plan')
  const search = result.rows.find((row) => row.action === 'search')
  assert.equal(search.credits, 2)
  assert.equal(search.revenueMilli, 100)
  assert.equal(search.unitCostMilli, 150)
  assert.equal(search.costKnown, true)
  assert.equal(search.marginMilli, -50)
  assert.equal(search.marginPct, -50)

  const chat = result.rows.find((row) => row.action === 'chat')
  assert.equal(chat.costKnown, false)
  assert.equal(chat.marginMilli, null)
  assert.equal(chat.marginPct, null)
  assert.match(chat.costReason, /没有可折算的用量/)

  const image = result.rows.find((row) => row.action === 'canvas_image')
  assert.equal(image.subsidized, true)
  assert.equal(image.credits, 0)
  assert.equal(image.revenueMilli, 0)
  // 不收费的两行按单位摊成本：一次成本 = 一张的成本（0.40 元 ÷ 4 张 = 0.10 元），不是按请求摊
  assert.equal(image.perUnit, true)
  assert.equal(image.unitCostMilli, 100)
  assert.equal(image.marginMilli, -100)
  assert.equal(image.marginPct, null, '没有收入，毛利率没有意义，不写一个假百分比')

  // 合计：收入只算有汇率的计费行（检索 0.10×2 + 对话 0.05×1 = 0.25），成本含不收费通道（0.30 + 0.40）
  assert.equal(result.totals.revenueMilli, 250)
  assert.equal(result.totals.costMilli, 700)
  assert.equal(result.totals.marginMilli, -450)
  assert.equal(result.totals.unbilledCostMilli, 400)
  assert.ok(result.warnings.some((line) => /画布出图.*不扣积分/.test(line)))
})

test('没有汇率就一个钱都不写：收入与毛利是 null，并给出「先加档位」的提示', () => {
  const result = pricing.unitEconomics({
    summary: summary([{ kind: 'search', calls: 1, failedCalls: 0, measuredCalls: 1, units: 1, estCostMilli: 100 }]),
    plans: [],
    creditPrices: { search: 2 },
  })
  assert.equal(result.rate.source, 'none')
  const search = result.rows.find((row) => row.action === 'search')
  assert.equal(search.revenueMilli, null)
  assert.equal(search.marginMilli, null)
  assert.equal(search.marginPct, null)
  assert.equal(result.totals.revenueMilli, null)
  assert.equal(result.totals.marginMilli, null)
  assert.ok(result.warnings.some((line) => /还没有定价档位/.test(line)))
})

test('只有回填记录时不算一次成本：分母为 0 就说「只有历史回填」，不摊成 0', () => {
  const result = pricing.unitEconomics({
    summary: summary([
      { kind: 'replicate', calls: 3, failedCalls: 0, measuredCalls: 0, units: 0, estCostMilli: 0 },
      { kind: 'run', calls: 0, failedCalls: 0, measuredCalls: 0, units: 0, estCostMilli: 0 },
    ]),
    plans: [PLAN_LOW],
    creditPrices: { replicate: 10, flow_run: 2 },
  })
  const replicate = result.rows.find((row) => row.action === 'replicate')
  assert.equal(replicate.costKnown, false)
  assert.match(replicate.costReason, /历史回填/)
  assert.equal(replicate.unitCostMilli, null)
  const run = result.rows.find((row) => row.action === 'flow_run')
  assert.match(run.costReason, /没有这类调用/)
  // 有汇率、但一次带用量的调用都没有：窗口收入不是 0（那会读成「真的收了 0 元」），是 null
  assert.equal(result.totals.revenueMilli, null)
  assert.equal(result.totals.marginMilli, null)
  assert.ok(result.warnings.some((line) => /没有带用量的调用/.test(line)))
})

test('端到端：真实用量事件 + 估算单价 + 档位，算出这一次的账', () => {
  usage.resetUsageMeter()
  plans.resetPlansCache()
  // 文本一次 1000 入 / 500 出 token；出图一次 2 张
  usage.recordUsage({ kind: 'text', model: 'deepseek-flash', tokensIn: 1000, tokensOut: 500 })
  usage.recordUsage({ kind: 'image', model: 'image-2-pro', units: 2 })
  // 单价：输入 2 元/百万 token、输出 8 元/百万 token、出图 0.25 元/张
  const saved = usage.saveUsagePrices({ inPerMillion: 2, outPerMillion: 8, imagePerShot: 0.25 })
  assert.equal(saved.ok, true)
  const plan = plans.savePlan({ name: '体验档', credits: 1000, priceCents: 5000 })
  assert.equal(plan.ok, true)

  const estimate = pricing.pricingEstimate({ days: 30 })
  assert.equal(estimate.ok, true)
  assert.equal(estimate.rate.source, 'plan')
  assert.equal(estimate.rate.rmbPerCredit, 0.05)
  assert.equal(estimate.pricesPriced, true)

  const chat = estimate.rows.find((row) => row.action === 'chat')
  // 0.002 元（入）+ 0.004 元（出）= 0.006 元 = 6 毫元；收入 1 积分 × 0.05 = 50 毫元
  assert.equal(chat.unitCostMilli, 6)
  assert.equal(chat.revenueMilli, 50)
  assert.equal(chat.marginMilli, 44)
  assert.equal(chat.marginPct, 88)

  const image = estimate.rows.find((row) => row.action === 'canvas_image')
  assert.equal(image.costMilli, 500, '2 张 × 0.25 元')
  assert.equal(image.unitCostMilli, 250, '一张 0.25 元，不是一次请求 0.25 元')
  assert.equal(image.revenueMilli, 0)
  assert.equal(image.marginMilli, -250)
  assert.equal(estimate.totals.unbilledCostMilli, 500)
})

function mockReq({ method = 'GET', cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
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

const call = async (router, req, target) => {
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  await router.handle(req, res, url, url.pathname)
  return res
}

test('后台接口：管理员只读、非管理员 403、汇率写坏 400、天数夹到 90、手填汇率生效', async () => {
  const router = createAdminRouter()

  const denied = await call(router, mockReq({ cookie: plainCookie }), '/api/admin/pricing/estimate?days=30')
  assert.equal(denied.statusCode, 403)

  const read = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/pricing/estimate?days=30')
  assert.equal(read.statusCode, 200)
  const payload = JSON.parse(read.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.days, 30)
  assert.equal(payload.rate.source, 'plan', '有档位时按档位折算')
  assert.ok(payload.rows.length >= 5)
  assert.ok(payload.totals.measured >= 2)
  assert.ok(Array.isArray(payload.warnings) && payload.warnings.length > 0)

  const custom = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/pricing/estimate?days=7&rate=0.2')
  assert.equal(custom.statusCode, 200)
  const customPayload = JSON.parse(custom.body)
  assert.equal(customPayload.days, 7)
  assert.equal(customPayload.rate.source, 'custom')
  assert.equal(customPayload.rate.rmbPerCredit, 0.2)

  const tooLong = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/pricing/estimate?days=999')
  assert.equal(tooLong.statusCode, 200)
  assert.equal(JSON.parse(tooLong.body).days, 90, '窗口最多 90 天，和成本页同一口径')

  const bad = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/pricing/estimate?rate=abc')
  assert.equal(bad.statusCode, 400)
  assert.equal(JSON.parse(bad.body).code, 'BAD_RATE')

  const unknownPlan = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/pricing/estimate?plan=plan_missing')
  assert.equal(unknownPlan.statusCode, 200)
  assert.equal(JSON.parse(unknownPlan.body).rate.source, 'plan', '档位不存在时退回最划算的一档，不报错')
})
