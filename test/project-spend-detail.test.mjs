// 花费明细（v0.9.66）：合计能点开，点开后还加得回去。
// 这一组盯住四件事：
//   1) 逐笔列出评审与画布运行、按时间倒序；退过款的那次照样列出并标 refunded，但不进合计；
//   2) 按版本各多少（「改一版花多少」看得见），按 UTC 自然月分桶且退款不进月份；
//   3) 口径与 v0.9.65 的合计完全同源：逐笔（去掉退款）加总 = 详情 spend.total，
//      运行次数与作品页的「画布运行 N 次」是同一个数（没扣积分的运行也算一次）；
//   4) 别的画布的运行 / 别人的评审 / 别人的作品都不进来。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-spend-detail-'))
process.env.VQ_KEY_SECRET = 'test-secret-spend-detail'

// flows 模块第一次读盘之前先把 runs.json 落好（与 project-spend 那组同一套做法）：
// flow_a 是这条作品的画布；run_refund 是失败已退的；run_free 没扣积分；
// run_otherflow 是另一块画布的。
fs.writeFileSync(
  path.join(process.env.DATA_DIR, 'runs.json'),
  JSON.stringify([
    {
      id: 'run_ok', flowId: 'flow_a', flowName: '作品画布', status: 'success',
      startedAt: '2026-11-12T10:02:00.000Z', finishedAt: '2026-11-12T10:03:00.000Z',
      durationMs: 60000, total: 2, nodes: [], output: '', credits: { cost: 1, refunded: false },
    },
    {
      id: 'run_refund', flowId: 'flow_a', flowName: '作品画布', status: 'error',
      startedAt: '2026-11-12T09:56:00.000Z', finishedAt: '2026-11-12T09:57:00.000Z',
      durationMs: 60000, total: 2, nodes: [], output: '', error: '上游超时', credits: { cost: 1, refunded: true },
    },
    {
      id: 'run_free', flowId: 'flow_a', flowName: '探活', status: 'success',
      startedAt: '2026-11-12T08:00:00.000Z', finishedAt: '2026-11-12T08:00:01.000Z',
      durationMs: 1000, total: 1, nodes: [], output: '', credits: null,
    },
    {
      id: 'run_old', flowId: 'flow_a', flowName: '作品画布', status: 'success',
      startedAt: '2026-10-31T23:50:00.000Z', finishedAt: '2026-10-31T23:51:00.000Z',
      durationMs: 60000, total: 2, nodes: [], output: '', credits: { cost: 2, refunded: false },
    },
    {
      id: 'run_otherflow', flowId: 'flow_b', flowName: '别的画布', status: 'success',
      startedAt: '2026-11-12T07:00:00.000Z', finishedAt: '2026-11-12T07:01:00.000Z',
      durationMs: 60000, total: 1, nodes: [], output: '', credits: { cost: 3, refunded: false },
    },
  ]),
  'utf8',
)

const auth = await import('../server/auth.mjs')
const projects = await import('../server/projects.mjs')
const { projectSpendDetail } = await import('../server/project-spend.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

const alice = auth.createUser({ email: '[EMAIL:DETAIL1]', password: 'Passw0rd!demo', name: '阿栗', kind: 'user' })
const bob = auth.createUser({ email: '[EMAIL:DETAIL2]', password: 'Passw0rd!demo', name: '小博', kind: 'user' })
const project = await projects.createProject({ title: '毛衣折叠收纳法', flowId: 'flow_a' }, alice)

// 评审记录直接落盘：saveReview 自己盖 createdAt，测不出「上个月那笔」；
// 顺便把「没挂作品的」「别人的」两条一起摆进去。
fs.writeFileSync(
  path.join(process.env.DATA_DIR, 'reviews.json'),
  JSON.stringify([
    {
      id: 'rev_v2', ownerId: alice.id, projectId: project.id, version: 2, intent: '开场三秒看不看得懂',
      source: { kind: 'frame', label: '', media: '', imageUrl: '' }, credits: { cost: 5, balance: 95 },
      result: { verdict: 'needs_review' }, createdAt: '2026-11-12T11:00:00.000Z',
    },
    {
      id: 'rev_v1', ownerId: alice.id, projectId: project.id, version: 0, intent: '再看一次主体',
      source: { kind: 'frame', label: '', media: '', imageUrl: '' }, credits: { cost: 5, balance: 90 },
      result: { verdict: 'pass' }, createdAt: '2026-10-31T22:00:00.000Z',
    },
    {
      id: 'rev_orphan', ownerId: alice.id, projectId: '', version: 0, intent: '首帧评审',
      source: { kind: 'frame', label: '', media: '', imageUrl: '' }, credits: { cost: 5, balance: 85 },
      result: { verdict: 'pass' }, createdAt: '2026-11-12T09:00:00.000Z',
    },
    {
      id: 'rev_bob', ownerId: bob.id, projectId: project.id, version: 1, intent: '别人评的',
      source: { kind: 'frame', label: '', media: '', imageUrl: '' }, credits: { cost: 7, balance: 50 },
      result: { verdict: 'fail' }, createdAt: '2026-11-12T08:30:00.000Z',
    },
  ]),
  'utf8',
)

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

// 带上 query 的路径要拆开：路由按 pathname 匹配，查询串从第三个参数里取
const call = async (router, req, target) => {
  const url = new URL('http://127.0.0.1' + target)
  const res = mockRes()
  await router.handle(req, res, url, url.pathname)
  return res
}

test('逐笔列出：按时间倒序，退款的标出来且不进合计', async () => {
  const detail = await projectSpendDetail(project, alice)
  assert.equal(detail.scope, 'all')
  assert.match(detail.month, /^\d{4}-\d{2}$/)
  assert.equal(detail.unit, '积分')
  // 评审 5+5；运行里没退的 1+2；退的 1 不算
  assert.equal(detail.total, 13)
  assert.deepEqual(detail.reviews, { count: 2, credits: 10 })
  assert.deepEqual(detail.runs, { count: 4, credits: 3 })
  assert.deepEqual(detail.refunded, { count: 1, credits: 1 })
  assert.equal(detail.count, 6)
  assert.equal(detail.shown, 6)
  assert.deepEqual(detail.items.map((item) => item.kind + ':' + item.id), [
    'review:rev_v2',
    'run:run_ok',
    'run:run_refund',
    'run:run_free',
    'run:run_old',
    'review:rev_v1',
  ])
  assert.equal(detail.items.find((item) => item.id === 'run_refund').refunded, true)
  assert.equal(detail.items.find((item) => item.id === 'run_ok').refunded, false)
  // 没扣积分的运行照样列、金额是 0；别的画布的运行、别人的评审、没挂作品的评审都不在
  const free = detail.items.find((item) => item.id === 'run_free')
  assert.equal(free.credits, 0)
  assert.equal(free.charged, false)
  const ids = detail.items.map((item) => item.id)
  assert.equal(ids.includes('run_otherflow'), false)
  assert.equal(ids.includes('rev_bob'), false)
  assert.equal(ids.includes('rev_orphan'), false)
})

test('按版本：改一版花多少看得见，版本倒序', async () => {
  const detail = await projectSpendDetail(project, alice)
  assert.deepEqual(detail.byVersion.map((row) => row.version), [2, 1])
  const v2 = detail.byVersion[0]
  assert.deepEqual(v2.reviews, { count: 1, credits: 5 })
  assert.deepEqual(v2.runs, { count: 0, credits: 0 })
  assert.equal(v2.total, 5)
  // 画布是 v1 的：四笔运行都记在 v1（退过款的那次算次数、不算积分）
  const v1 = detail.byVersion[1]
  assert.deepEqual(v1.reviews, { count: 1, credits: 5 })
  assert.deepEqual(v1.runs, { count: 4, credits: 3 })
  assert.equal(v1.total, 8)
  assert.equal(v1.reviews.credits + v1.runs.credits, v1.total)
})

test('按月份：UTC 自然月分桶，退款不进任何月份', async () => {
  const detail = await projectSpendDetail(project, alice)
  assert.deepEqual(detail.byMonth.map((row) => row.month), ['2026-11', '2026-10'])
  const nov = detail.byMonth[0]
  assert.equal(nov.total, 6, '11 月：评审 5 + 没退的运行 1')
  assert.equal(nov.reviews, 5)
  assert.equal(nov.runs, 1)
  assert.equal(nov.count, 3)
  const oct = detail.byMonth[1]
  assert.equal(oct.total, 7, '10 月：评审 5 + 运行 2')
  assert.equal(oct.count, 2)
  // 只问 10 月：合计与逐笔都只剩那个月，月份表不跟着缩水
  const onlyOct = await projectSpendDetail(project, alice, { month: '2026-10' })
  assert.equal(onlyOct.scope, '2026-10')
  assert.equal(onlyOct.total, 7)
  assert.equal(onlyOct.count, 2)
  assert.deepEqual(onlyOct.items.map((item) => item.id), ['run_old', 'rev_v1'])
  assert.deepEqual(onlyOct.byMonth.map((row) => row.month), ['2026-11', '2026-10'])
  // 没花过钱的月份：0，不编数字
  const empty = await projectSpendDetail(project, alice, { month: '2026-09' })
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.byVersion, [])
})

test('逐笔加起来等于详情里的合计：接口与作品页同一个数', async () => {
  const router = createProjectsRouter()
  const cookie = auth.sessionCookie(auth.createSession(alice, { userAgent: 'test', ip: '10.0.9.1' }).token).split(';')[0]
  const spendRes = await call(router, mockReq({ cookie }), '/api/projects/' + project.id + '/spend')
  assert.equal(spendRes.statusCode, 200)
  const spend = JSON.parse(spendRes.body)
  const sum = spend.items.filter((item) => !item.refunded).reduce((total, item) => total + item.credits, 0)
  assert.equal(sum, spend.total, '逐笔（去掉退款）加起来必须等于合计')

  const detailRes = await call(router, mockReq({ cookie }), '/api/projects/' + project.id)
  assert.equal(detailRes.statusCode, 200)
  const page = JSON.parse(detailRes.body)
  assert.equal(page.spend.total, spend.total)
  assert.equal(page.spend.reviews.credits, spend.reviews.credits)
  assert.equal(page.spend.runs.credits, spend.runs.credits)
  assert.equal(page.spend.runs.count, spend.runs.count, '运行次数与作品页同一个数')
  assert.equal(page.spend.lastAt, spend.lastAt)

  // 月份参数走接口：只给那个月
  const octRes = await call(router, mockReq({ cookie }), '/api/projects/' + project.id + '/spend?month=2026-10')
  assert.equal(JSON.parse(octRes.body).total, 7)
  // 乱写的月份当累计，不当成空
  const badRes = await call(router, mockReq({ cookie }), '/api/projects/' + project.id + '/spend?month=2026-1')
  assert.equal(JSON.parse(badRes.body).scope, 'all')
})

test('别人的作品与不存在的作品：404，不给人看也不给空壳', async () => {
  const router = createProjectsRouter()
  const bobCookie = auth.sessionCookie(auth.createSession(bob, { userAgent: 'test', ip: '10.0.9.2' }).token).split(';')[0]
  const denied = await call(router, mockReq({ cookie: bobCookie }), '/api/projects/' + project.id + '/spend')
  assert.equal(denied.statusCode, 404)
  const missing = await call(router, mockReq({ cookie: bobCookie }), '/api/projects/prj_nope/spend')
  assert.equal(missing.statusCode, 404)
})
