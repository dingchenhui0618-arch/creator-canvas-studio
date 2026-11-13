// 钱花在哪（v0.9.65）。这一组盯住三件事：
//   1) 账号本月按动作拆开的消耗：退款抵回去，管理员扣减与赠送不算，上月的花费不算本月，
//      合计必须与每月额度的「本月已用」是同一个数；
//   2) 一条作品上的花费：评审记录自己记着成本，运行记录跨版本按画布归集，退过款的那次不算，
//      别人的作品与没记作品的评审都不硬塞进来；
//   3) 接口口径：作品详情与作品列表给的是同一份数字，空作品是 0 而不是编一个数。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-spend-'))
process.env.VQ_KEY_SECRET = 'test-secret-spend'

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const quota = await import('../server/quota.mjs')
const reviews = await import('../server/reviews.mjs')
const flows = await import('../server/flows.mjs')
const projects = await import('../server/projects.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

const alice = auth.createUser({ email: '[EMAIL:SPEND1]', password: 'Passw0rd!demo', name: '阿栗', kind: 'user' })
const bob = auth.createUser({ email: '[EMAIL:SPEND2]', password: 'Passw0rd!demo', name: '小博', kind: 'user' })

// 运行的积分记在 runs.json 里：flows 模块第一次读盘之前先落好，免得和模块内的缓存打架。
// run_a2 是失败已退的、run_other 是别人的、run_b1 是另一块画布的。
fs.writeFileSync(
  path.join(process.env.DATA_DIR, 'runs.json'),
  JSON.stringify([
    {
      id: 'run_a1', flowId: 'flow_a', flowName: '作品画布', status: 'success',
      startedAt: '2026-11-12T10:02:00.000Z', finishedAt: '2026-11-12T10:03:00.000Z',
      durationMs: 60000, total: 2, nodes: [], output: '', ownerId: alice.id, credits: { cost: 2, refunded: false },
    },
    {
      id: 'run_a2', flowId: 'flow_a', flowName: '作品画布', status: 'error',
      startedAt: '2026-11-12T09:56:00.000Z', finishedAt: '2026-11-12T09:57:00.000Z',
      durationMs: 60000, total: 2, nodes: [], output: '', error: '上游超时', ownerId: alice.id, credits: { cost: 2, refunded: true },
    },
    {
      id: 'run_b1', flowId: 'flow_b', flowName: '别的画布', status: 'success',
      startedAt: '2026-11-12T09:50:00.000Z', finishedAt: '2026-11-12T09:51:00.000Z',
      durationMs: 60000, total: 1, nodes: [], output: '', ownerId: alice.id, credits: { cost: 2, refunded: false },
    },
    {
      id: 'run_other', flowId: 'flow_a', flowName: '别人的运行', status: 'success',
      startedAt: '2026-11-12T09:40:00.000Z', finishedAt: '2026-11-12T09:41:00.000Z',
      durationMs: 60000, total: 1, nodes: [], output: '', ownerId: bob.id, credits: { cost: 2, refunded: false },
    },
  ]),
  'utf8',
)

credits.grant(alice.id, 200, { note: '测试发放' })
credits.grant(bob.id, 200, { note: '测试发放' })
// 阿栗本月：检索 2+2 退 2 → 2；评审 5；画布运行 2；复刻 10 全退 → 0。合计 9。
credits.charge(alice.id, 'search')
credits.charge(alice.id, 'search')
credits.refund(alice.id, 'search', { amount: 2 })
credits.charge(alice.id, 'review')
credits.charge(alice.id, 'flow_run')
credits.charge(alice.id, 'replicate')
credits.refund(alice.id, 'replicate', { amount: 10 })
// 管理员扣减不是消耗
credits.grant(alice.id, -1)
credits.charge(bob.id, 'search')

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

test('本月消耗按动作拆开：退款抵回去，扣减与赠送不算，合计等于每月已用', () => {
  const view = credits.spendBreakdown(alice.id)
  const byKind = Object.fromEntries(view.items.map((item) => [item.kind, item]))
  assert.equal(byKind.search.credits, 2, '检索扣了 4 退 2，净 2')
  assert.equal(byKind.search.label, '检索')
  assert.equal(byKind.search.calls, 2)
  assert.equal(byKind.review.credits, 5)
  assert.equal(byKind.flow_run.credits, 2)
  assert.equal(byKind.replicate.credits, 0, '整单退款：花过但没花掉，按 0 算')
  assert.equal(byKind.deduct, undefined, '管理员扣减不是消耗')
  assert.equal(byKind.grant, undefined, '赠送不是消耗')
  assert.equal(view.total, 9)
  assert.equal(view.unit, '积分')
  assert.equal(view.total, quota.quotaOf(alice.id).used, '与每月额度的「本月已用」是同一个数')
  // 排序：花得多的在前
  assert.deepEqual(view.items.map((item) => item.kind), ['review', 'flow_run', 'search', 'replicate'])
})

test('上月的花费不算本月：按 UTC 自然月切', () => {
  const now = new Date()
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString()
  auth
    .openDb()
    .prepare('INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('cl_spend_last_month', alice.id, -40, 160, 'replicate', '上月任务', null, lastMonth)
  const view = credits.spendBreakdown(alice.id)
  assert.equal(view.total, 9)
  assert.equal(view.items.some((item) => item.credits === 40), false)
})

test('没有登录态与没有流水：给空视图，不编数字', () => {
  const anonymous = credits.spendBreakdown(null)
  assert.deepEqual(anonymous.items, [])
  assert.equal(anonymous.total, 0)
  const bobView = credits.spendBreakdown(bob.id)
  assert.equal(bobView.total, 2)
  assert.deepEqual(bobView.items.map((item) => item.kind), ['search'])
})

test('作品的评审花费：只算记在这条作品下的，别人的看不见', async () => {
  const project = await projects.createProject({ title: '毛衣折叠收纳法', flowId: 'flow_a' }, alice)
  await reviews.saveReview({ user: alice, intent: '开场三秒看不看得懂', projectId: project.id, credits: { cost: 5, balance: 190 }, result: { verdict: 'needs_review' } })
  await reviews.saveReview({ user: alice, intent: '再看一次主体', projectId: project.id, credits: { cost: 5, balance: 185 }, result: { verdict: 'pass' } })
  // 没记作品的普通评审、别人的评审都不该进来
  await reviews.saveReview({ user: alice, intent: '首帧评审', projectId: '', credits: { cost: 5, balance: 180 }, result: { verdict: 'pass' } })
  const spend = await reviews.reviewSpend(project.id, alice)
  assert.equal(spend.count, 2)
  assert.equal(spend.credits, 10)
  assert.ok(spend.lastAt)
  const counts = await reviews.reviewCountsByProject(alice)
  assert.equal(counts[project.id].credits, 10, '列表口径与详情口径同一个数')
  assert.equal((await reviews.reviewSpend(project.id, bob)).count, 0, '别人的作品看不见')
})

test('运行的积分按画布归集：退款的那次不算，别人的运行不算', async () => {
  const own = await flows.listRunsByFlows(['flow_a'], { limit: 10 }, alice)
  assert.equal(own.total, 2, '别人的 run_other 不算进来')
  assert.equal(own.byFlow.flow_a, 2, '次数含退过款的那次')
  assert.equal(own.creditsByFlow.flow_a, 2, '积分只算没退的')
  const both = await flows.listRunsByFlows(['flow_a', 'flow_b'], { limit: 10 }, alice)
  assert.equal(both.creditsByFlow.flow_b, 2)
  const empty = await flows.listRunsByFlows([], {}, alice)
  assert.deepEqual(empty, { items: [], total: 0, byFlow: {}, creditsByFlow: {} })
})

test('作品详情与列表：花费同一份数（评审 10 + 没退的运行 2 = 12）', async () => {
  const router = createProjectsRouter()
  const cookie = auth.sessionCookie(auth.createSession(alice, { userAgent: 'test', ip: '10.0.3.1' }).token).split(';')[0]
  const list = await call(router, mockReq({ cookie }), '/api/projects')
  assert.equal(list.statusCode, 200)
  const row = JSON.parse(list.body).items.find((item) => item.title === '毛衣折叠收纳法')
  assert.ok(row, '作品在列表里')
  assert.equal(row.spend.total, 12)
  assert.equal(row.spend.reviews.credits, 10)
  assert.equal(row.spend.runs.credits, 2)

  const detail = await call(router, mockReq({ cookie }), '/api/projects/' + row.id)
  assert.equal(detail.statusCode, 200)
  const body = JSON.parse(detail.body)
  assert.equal(body.spend.total, 12)
  assert.equal(body.spend.reviews.count, 2)
  assert.equal(body.spend.runs.count, 2, '次数含退过款的那次')
  assert.equal(body.spend.unit, '积分')
  assert.ok(body.spend.lastAt)
  // 详情里的评审列表只有 2 条，与花费口径不打架：花费按全部评审记
  assert.equal(body.reviews.length, 2)
})

test('还没花过钱的作品：花费是 0、最近一次是空串，不编一个时间', async () => {
  const project = await projects.createProject({ title: '刚开的作品' }, alice)
  const router = createProjectsRouter()
  const cookie = auth.sessionCookie(auth.createSession(alice, { userAgent: 'test', ip: '10.0.3.2' }).token).split(';')[0]
  const detail = await call(router, mockReq({ cookie }), '/api/projects/' + project.id)
  const body = JSON.parse(detail.body)
  assert.equal(body.spend.total, 0)
  assert.equal(body.spend.reviews.credits, 0)
  assert.equal(body.spend.runs.credits, 0)
  assert.equal(body.spend.lastAt, '')
})
