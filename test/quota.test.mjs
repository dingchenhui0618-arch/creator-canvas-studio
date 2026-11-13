// 每月额度（v0.9.64）。这一组盯住五件事：
//   1) 默认不限：没定数字之前不偷偷设上限，扣费照常；
//   2) 超限整单拒绝：429 + 中文原因，余额与流水都不动，免费调用不受限；
//   3) 按账号覆盖：只影响那一个人，0 表示这个账号不限；
//   4) 口径只看账本：退款抵回、管理员扣减不算消耗、上月的花费不算本月；
//   5) 后台可改：改完立刻生效，坏输入 400、清不存在的覆盖 404、非管理员 403。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-quota-'))
process.env.VQ_KEY_SECRET = 'test-secret-quota'

const auth = await import('../server/auth.mjs')
const quota = await import('../server/quota.mjs')
const credits = await import('../server/credits.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')
const { createCreditsRouter } = await import('../server/routes/credits.mjs')

const admin = auth.createUser({ email: '[EMAIL:ADMIN1]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const alice = auth.createUser({ email: '[EMAIL:USER1]', password: 'Passw0rd!demo', name: '阿栗', kind: 'user' })
const bob = auth.createUser({ email: '[EMAIL:USER2]', password: 'Passw0rd!demo', name: '小博', kind: 'user' })
const carol = auth.createUser({ email: '[EMAIL:USER3]', password: 'Passw0rd!demo', name: '上个月的人', kind: 'user' })

const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.1.1' }).token).split(';')[0]
const aliceCookie = auth.sessionCookie(auth.createSession(alice, { userAgent: 'test', ip: '10.0.1.2' }).token).split(';')[0]

for (const user of [alice, bob, carol]) credits.grant(user.id, 500, { note: '测试发放' })

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

test('默认不限：额度 0 时照常扣费，remaining 是 -1 而不是编出来的数字', () => {
  quota.resetQuotaCache()
  const view = quota.quotaOf(alice.id)
  assert.equal(view.unlimited, true)
  assert.equal(view.limit, 0)
  assert.equal(view.remaining, -1)
  assert.equal(view.overridden, false)

  const paid = credits.charge(alice.id, 'search')
  assert.equal(paid.ok, true)
  assert.equal(paid.cost, 2)
  assert.equal(quota.quotaOf(alice.id).used, 2, '扣费后本月消耗就是这一笔')
})

test('设了上限，超出就整单拒绝：不扣积分、不落流水，免费调用不受限', () => {
  const saved = quota.saveQuota({ monthlyLimit: 3 }, '[EMAIL:ADMIN1]')
  assert.equal(saved.ok, true)
  assert.equal(saved.monthlyLimit, 3)

  const beforeBalance = credits.balanceOf(alice.id)
  const beforeLedger = credits.ledgerCountOf(alice.id)
  // 已用 2，再来一次检索要 2 → 4 > 3
  const blocked = credits.charge(alice.id, 'search')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'MONTHLY_QUOTA')
  assert.equal(blocked.limit, 3)
  assert.equal(blocked.used, 2)
  assert.equal(blocked.cost, 2)
  assert.equal(blocked.remaining, 1)
  assert.match(blocked.message, /本月额度用完了/)
  assert.match(blocked.message, /每月 1 日（UTC）重置/)
  assert.match(blocked.message, /单独提额/)
  assert.equal(credits.balanceOf(alice.id), beforeBalance, '拒绝时不扣余额')
  assert.equal(credits.ledgerCountOf(alice.id), beforeLedger, '拒绝时不落流水')

  // 免费调用（单价 0）不受额度限制，否则改价或赠送也会被挡
  const free = credits.charge(alice.id, 'search', { amount: 0 })
  assert.equal(free.ok, true)
})

test('额度是数据：后台改默认额度立刻生效，校验拒绝负数、小数与非数字', () => {
  assert.equal(quota.saveQuota({ monthlyLimit: -1 }, 'x').ok, false)
  assert.equal(quota.saveQuota({ monthlyLimit: 1.5 }, 'x').ok, false)
  assert.equal(quota.saveQuota({ monthlyLimit: 'x' }, 'x').ok, false)
  assert.match(quota.saveQuota({ monthlyLimit: -1 }, 'x').error, /0–1000000 的整数/)

  const raised = quota.saveQuota({ monthlyLimit: 200 }, '[EMAIL:ADMIN1]')
  assert.equal(raised.monthlyLimit, 200)
  assert.equal(quota.quotaOf(alice.id).limit, 200, '同一个进程里下一次读就是新数字')
  const paid = credits.charge(alice.id, 'search')
  assert.equal(paid.ok, true)
  assert.equal(quota.quotaOf(alice.id).used, 4)
  quota.saveQuota({ monthlyLimit: 0 }, '[EMAIL:ADMIN1]')
})

test('按账号覆盖：只影响一个人，0 表示这个账号不限', () => {
  const set = quota.setQuotaOverride(alice.id, 4, '[EMAIL:ADMIN1]')
  assert.equal(set.ok, true)
  assert.equal(set.limit, 4)
  assert.equal(set.overridden, true, '覆盖过就一定标出来')

  assert.equal(quota.quotaOf(bob.id).unlimited, true, '别人继续走默认')
  const blocked = credits.charge(alice.id, 'review') // 已用 4 + 5 > 4
  assert.equal(blocked.code, 'MONTHLY_QUOTA')
  const allowed = credits.charge(bob.id, 'review')
  assert.equal(allowed.ok, true)

  assert.equal(quota.setQuotaOverride(alice.id, 0, '[EMAIL:ADMIN1]').unlimited, true, '0 是「这个账号不限」')
  const free = credits.charge(alice.id, 'review')
  assert.equal(free.ok, true)

  assert.equal(quota.setQuotaOverride(alice.id, 9, '[EMAIL:ADMIN1]').limit, 9)
  const cleared = quota.clearQuotaOverride(alice.id)
  assert.equal(cleared.ok, true)
  assert.equal(quota.quotaOf(alice.id).overridden, false)
  assert.equal(quota.quotaOf(alice.id).unlimited, true)
  assert.equal(quota.clearQuotaOverride(alice.id).code, 'NOT_FOUND')
  assert.equal(quota.setQuotaOverride('user_missing', 5, 'x').code, 'NOT_FOUND')
})

test('本月消耗的口径：退款抵回，管理员扣减与赠送都不算消耗', () => {
  const base = quota.monthlySpend(bob.id)
  assert.ok(base >= 5)
  credits.refund(bob.id, 'review', { ref: '测试退款' })
  assert.equal(quota.monthlySpend(bob.id), base - 5, '退回的积分不算花掉')

  credits.grant(bob.id, 100, { note: '充值' })
  assert.equal(quota.monthlySpend(bob.id), base - 5, '赠送不算消耗')
  credits.grant(bob.id, -3, { note: '管理员扣减' })
  assert.equal(quota.monthlySpend(bob.id), base - 5, '管理员扣减不算消耗')
})

test('按 UTC 自然月统计：上月扣的积分不算这个月', () => {
  const now = new Date()
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 3, 0, 0)).toISOString()
  auth
    .openDb()
    .prepare('INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('cl_last_month', carol.id, -40, 460, 'replicate', '上月任务', null, lastMonth)
  assert.equal(quota.monthlySpend(carol.id), 0)
  assert.equal(quota.quotaOf(carol.id).used, 0)
})

test('后台视图：只列花过钱或设过单独额度的账号，按消耗从多到少', () => {
  quota.setQuotaOverride(carol.id, 30, '[EMAIL:ADMIN1]')
  const view = quota.quotaOverview()
  assert.equal(view.monthlyLimit, 0)
  assert.equal(view.overrideCount, 1)
  const emails = view.rows.map((row) => row.email)
  assert.ok(emails.includes(alice.email))
  // 小博本月花的都退回了、也没设单独额度：净消耗 0，不列（否则会是一堆 0 行）
  assert.equal(emails.includes(bob.email), false)
  assert.ok(emails.includes(carol.email), '没花钱但设了单独额度，也要列出来');
  assert.equal(emails.includes(admin.email), false, '没花钱也没设额度的不列')
  for (let i = 1; i < view.rows.length; i += 1) {
    assert.ok(view.rows[i - 1].used >= view.rows[i].used, '按本月消耗降序')
  }
  const carolRow = view.rows.find((row) => row.userId === carol.id)
  assert.equal(carolRow.used, 0)
  assert.equal(carolRow.override, 30)
  assert.equal(carolRow.unlimited, false)
  quota.clearQuotaOverride(carol.id)
})

test('429 拒绝体：字段齐、状态码对，前端能直接照着显示', () => {
  quota.saveQuota({ monthlyLimit: 1 }, '[EMAIL:ADMIN1]')
  const paid = credits.charge(alice.id, 'chat')
  assert.equal(paid.ok, false)
  const refusal = quota.quotaRefusal(paid)
  assert.equal(refusal.status, 429)
  assert.equal(refusal.body.code, 'MONTHLY_QUOTA')
  assert.equal(refusal.body.limit, 1)
  assert.equal(refusal.body.cost, 1)
  assert.equal(refusal.body.remaining, 0)
  assert.match(refusal.body.month, /^\d{4}-\d{2}$/)
  assert.match(refusal.body.resetAt, /^\d{4}-\d{2}-01T00:00:00\.000Z$/)
  assert.match(refusal.body.error, /本月额度用完了/)
  quota.saveQuota({ monthlyLimit: 0 }, '[EMAIL:ADMIN1]')
})

test('后台路由：非管理员 403、坏输入 400、改默认额度与单独额度都通', async () => {
  const denied = await call(adminRouter, mockReq({ cookie: aliceCookie }), '/api/admin/quota')
  assert.equal(denied.statusCode, 403)

  const listed = await call(adminRouter, mockReq({ cookie: adminCookie }), '/api/admin/quota')
  assert.equal(listed.statusCode, 200)
  assert.equal(JSON.parse(listed.body).monthlyLimit, 0)

  const bad = await call(adminRouter, mockReq({ method: 'PUT', cookie: adminCookie, body: { monthlyLimit: -5 } }), '/api/admin/quota')
  assert.equal(bad.statusCode, 400)

  const saved = await call(adminRouter, mockReq({ method: 'PUT', cookie: adminCookie, body: { monthlyLimit: 60 } }), '/api/admin/quota')
  assert.equal(saved.statusCode, 200)
  assert.equal(JSON.parse(saved.body).monthlyLimit, 60)
  assert.equal(quota.quotaOf(bob.id).limit, 60)

  const patched = await call(adminRouter, mockReq({ method: 'PUT', cookie: adminCookie, body: { limit: 12 } }), '/api/admin/quota/overrides/' + bob.id)
  assert.equal(patched.statusCode, 200)
  assert.equal(quota.quotaOf(bob.id).limit, 12)
  assert.equal(JSON.parse(patched.body).rows.some((row) => row.userId === bob.id && row.override === 12), true)

  const missing = await call(adminRouter, mockReq({ method: 'PUT', cookie: adminCookie, body: { limit: 3 } }), '/api/admin/quota/overrides/user_missing')
  assert.equal(missing.statusCode, 404)

  const cleared = await call(adminRouter, mockReq({ method: 'DELETE', cookie: adminCookie }), '/api/admin/quota/overrides/' + bob.id)
  assert.equal(cleared.statusCode, 200)
  assert.equal(quota.quotaOf(bob.id).limit, 60, '清掉覆盖后回到默认额度')
  const twice = await call(adminRouter, mockReq({ method: 'DELETE', cookie: adminCookie }), '/api/admin/quota/overrides/' + bob.id)
  assert.equal(twice.statusCode, 404)

  await call(adminRouter, mockReq({ method: 'PUT', cookie: adminCookie, body: { monthlyLimit: 0 } }), '/api/admin/quota')
})

test('/api/credits 带上额度视图：不限时如实写 unlimited，设了上限就给数字', async () => {
  const unlimited = await call(creditsRouter, mockReq({ cookie: aliceCookie }), '/api/credits')
  assert.equal(unlimited.statusCode, 200)
  const free = JSON.parse(unlimited.body)
  assert.equal(free.quota.unlimited, true)
  assert.equal(free.quota.remaining, -1)
  assert.ok(free.quota.used > 0)
  assert.match(free.quota.month, /^\d{4}-\d{2}$/)

  quota.saveQuota({ monthlyLimit: 100 }, '[EMAIL:ADMIN1]')
  const limited = await call(creditsRouter, mockReq({ cookie: aliceCookie }), '/api/credits')
  const view = JSON.parse(limited.body).quota
  assert.equal(view.unlimited, false)
  assert.equal(view.limit, 100)
  assert.equal(view.remaining, 100 - view.used)
  quota.saveQuota({ monthlyLimit: 0 }, '[EMAIL:ADMIN1]')
})
