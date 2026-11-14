// 画布运行的排队位（v0.9.96）。运行一条流程会下载并分析多张图，是最重的一条重活（3 积分/次）：
// 撞上整机上限时 v0.9.79~v0.9.95 一律立刻 503，用户只能自己再点一次。这一组盯住七件事：
//   1) 名额满时先排队，排到就进门；排队期间不扣积分、不跑流程（扣费发生在排到之后）；
//   2) 名次是整机口径：同一张票能按票号查到第几，两张票先来后到；
//   3) 排队位本身也有上限：排满了直接拒，不把连接堆在这里；
//   4) 等超时拒绝，而且始终不占名额（拒绝发生在扣费之前，这一单不花钱）；
//   5) 客户端提前断开就退出排队，不写响应；
//   6) 关了排队（waitMs / maxWaiting 写 0）退回立刻拒，画布出图 / 评审不受影响；
//   7) 路由层：票号从请求头进、名次与等待时长从响应头出，流里的第一条是 run-queue。
// 假上游不参与：这一组只测「进门之前」，一次模型调用都不发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-run-queue-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-run-queue'
process.env.VQ_RUN_QUEUE_MS = '4000'
process.env.VQ_RUN_QUEUE_MAX = '2'
process.env.VISION_API_KEY = ''
// 名额与排队位都按这个文件各算各的（测试文件是各自独立的进程）
isolateLeaseDir('vq-lease-run-queue-')

const { config } = await import('../server/config.mjs')
// 阈值写成 0 等于关掉水位那一条：这组测的是「排队」，不是「这台机器的内存」
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const queue = () => water.queueLimitsFor('flow_run')

const user = auth.createUser({ email: '[EMAIL:4R7M2Q]', password: 'Passw0rd!demo', name: '运行排队', kind: 'member' })
const balance = () => credits.balanceOf(user.id)
const ledgerRows = (kind) => credits.ledgerOf(user.id, 50).filter((row) => row.kind === kind)

/** 把整机的三条重活名额占满（占满才有得排）。返回放掉它们的函数。 */
async function holdFullCap() {
  const held = []
  for (let i = 0; i < 3; i += 1) {
    const got = lease.acquireHeavyLease('flow_run', { limit: 3, kindLimit: 0 })
    assert.equal(got.ok, true, '第 ' + (i + 1) + ' 条名额应该拿得到')
    held.push(got.lease)
  }
  return () => {
    for (const item of held) {
      try { item.release() } catch { /* 已经放掉 */ }
    }
  }
}

test('默认参数：运行 60 秒 / 4 条，画布出图 90 秒 / 8 条，评审 60 秒 / 4 条，复刻不排队', () => {
  // 这个进程里 env 覆盖成 4000 / 2：先证明配置真的读到了这一段
  assert.deepEqual(queue(), { waitMs: 4000, maxWaiting: 2 })
  // 另外两段没被连坐改掉（同一份配置里三段分开）
  assert.deepEqual(water.queueLimitsFor('canvas_gen'), { waitMs: 90000, maxWaiting: 8 })
  assert.deepEqual(water.queueLimitsFor('review'), { waitMs: 60000, maxWaiting: 4 })
  assert.deepEqual(water.queueLimitsFor('replicate'), { waitMs: 0, maxWaiting: 0 })
  assert.deepEqual(water.queueLimitsFor('run_nope'), { waitMs: 0, maxWaiting: 0 })

  // 生产默认值用干净的子进程量一次：本进程的 env 已经被测试改过
  const script = 'import("./server/config.mjs").then((m) => console.log(JSON.stringify(m.config.credits.runQueue)))'
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '--experimental-strip-types', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, VQ_RUN_QUEUE_MS: '', VQ_RUN_QUEUE_MAX: '' },
    encoding: 'utf8',
  })
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { waitMs: 60000, maxWaiting: 4 })
})

test('名额满时先排队：排到才占名额，名次与等待时长都是真数', async () => {
  const release = await holdFullCap()
  const ticket = 'run-ticket-one'
  const started = Date.now()
  const pending = water.admitWaiting('flow_run', { ticket })
  try {
    await sleep(220)
    // 排队中：按票号查得到自己是第 1 位，整机 1 条在等
    const view = water.queueView('flow_run', ticket)
    assert.equal(view.position, 1)
    assert.equal(view.ahead, 0)
    assert.equal(view.waiting, 1)
    assert.equal(view.kind, 'flow_run')
    assert.equal(view.scope, 'lease')
    assert.equal(view.countsScope, 'process')
    assert.equal(view.waitMs, 4000)
    // 还没排到：一条名额都没占（3 条还是别人的），账本里也没有这次运行的钱
    assert.equal(lease.heavyLeaseSnapshot().total, 3)
    assert.equal(ledgerRows('flow_run').length, 0)

    release()
    const got = await pending
    assert.equal(got.ok, true)
    assert.equal(got.queued, true)
    assert.equal(got.position, 1)
    assert.ok(got.waitedMs >= 150, '等了 ' + got.waitedMs + 'ms，至少要跨过一轮轮询')
    assert.ok(Date.now() - started >= got.waitedMs)
    // 排到之后才占名额（扣费与跑流程由路由在那之后做）
    assert.equal(lease.heavyLeaseSnapshot().total, 1)
    got.lease.release()
    // 进门后票就退出队了：再问名次是 null（页面据此收起「排队中」）
    assert.equal(water.queueView('flow_run', ticket).position, null)
    assert.equal(water.queueView('flow_run').waiting, 0)
  } finally {
    release()
    const leftover = await Promise.race([pending, sleep(50).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
  }
})

test('先来先得：两张票的名次是整机的顺序，不是各自进程里的 1', async () => {
  const release = await holdFullCap()
  const first = water.admitWaiting('flow_run', { ticket: 'run-ticket-a' })
  let second = null
  try {
    await sleep(160)
    second = water.admitWaiting('flow_run', { ticket: 'run-ticket-b' })
    await sleep(200)
    const a = water.queueView('flow_run', 'run-ticket-a')
    const b = water.queueView('flow_run', 'run-ticket-b')
    assert.equal(a.position, 1)
    assert.equal(b.position, 2)
    assert.equal(b.ahead, 1)
    assert.equal(water.queueView('flow_run').waiting, 2)
    release()
    const [gotA, gotB] = await Promise.all([first, second])
    assert.equal(gotA.ok, true)
    assert.equal(gotB.ok, true)
    gotA.lease.release()
    gotB.lease.release()
    assert.equal(water.queueView('flow_run').waiting, 0)
  } finally {
    release()
    for (const pending of [first, second]) {
      if (!pending) continue
      const leftover = await Promise.race([pending, sleep(50).then(() => null)])
      if (leftover && leftover.lease) leftover.lease.release()
    }
  }
})

test('排队位也满：直接拒，文案说的是「运行」而不是「生成」', async () => {
  const saved = config.credits.runQueue
  config.credits.runQueue = { waitMs: 4000, maxWaiting: 1 }
  const release = await holdFullCap()
  const first = water.admitWaiting('flow_run', { ticket: 'run-full-holder' })
  try {
    await sleep(120)
    const refused = await water.admitWaiting('flow_run', { ticket: 'run-full-late' })
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 503)
    assert.equal(refused.queueFull, true)
    assert.equal(refused.body.code, 'SERVER_BUSY')
    assert.equal(refused.body.retryAfterSec, 60)
    assert.match(refused.body.error, /运行/)
    assert.match(refused.body.error, /没有扣积分/)
    assert.doesNotMatch(refused.body.error, /生成/, '运行不该借用画布出图的话')
    // 排队位满了也不占名额
    assert.equal(lease.heavyLeaseSnapshot().total, 3)
  } finally {
    // 放掉名额后头名还要跨过一个轮询周期才进门（350ms + 抖动）：等它真的排到再放它走，
    // 否则这条 waiter 会以「还在等」的样子留在队里，把后面几条用例的名次全挤后一位。
    release()
    config.credits.runQueue = saved
    const leftover = await Promise.race([first, sleep(2000).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
  }
})

test('等超时：503 说清没扣积分、没占名额、票也退掉了', async () => {
  const saved = config.credits.runQueue
  config.credits.runQueue = { waitMs: 300, maxWaiting: 2 }
  const release = await holdFullCap()
  const started = Date.now()
  try {
    const got = await water.admitWaiting('flow_run', { ticket: 'run-timeout' })
    assert.equal(got.ok, false)
    assert.equal(got.status, 503)
    assert.equal(got.timedOut, true)
    assert.ok(got.waitedMs >= 250, '等了 ' + got.waitedMs + 'ms')
    assert.ok(Date.now() - started >= 250)
    assert.equal(got.lease, null)
    assert.equal(got.body.code, 'SERVER_BUSY')
    assert.match(got.body.error, /没有扣积分/)
    // 名额一条都没被它占走、队里也没有残留
    assert.equal(lease.heavyLeaseSnapshot().total, 3)
    assert.equal(water.queueView('flow_run').waiting, 0)
    assert.equal(water.queueView('flow_run', 'run-timeout').position, null)
  } finally {
    release()
    config.credits.runQueue = saved
  }
})

test('排队中客户端走了：退出排队、不写响应、不占名额', async () => {
  const release = await holdFullCap()
  let gone = false
  const pending = water.admitWaiting('flow_run', { ticket: 'run-abort', isAborted: () => gone })
  try {
    await sleep(120)
    assert.equal(water.queueView('flow_run', 'run-abort').position, 1)
    gone = true
    const got = await pending
    assert.equal(got.ok, false)
    assert.equal(got.aborted, true)
    assert.equal(got.status, 499)
    assert.equal(lease.heavyLeaseSnapshot().total, 3)
    assert.equal(water.queueView('flow_run').waiting, 0)
  } finally {
    release()
  }
})

test('关了排队（waitMs 写 0）退回立刻拒，画布出图与评审不受影响', async () => {
  const saved = config.credits.runQueue
  config.credits.runQueue = { waitMs: 0, maxWaiting: 4 }
  const release = await holdFullCap()
  try {
    const started = Date.now()
    const got = await water.admitWaiting('flow_run', { ticket: 'run-off' })
    assert.equal(got.ok, false)
    assert.equal(got.queued, false)
    assert.equal(got.timedOut, undefined)
    assert.ok(Date.now() - started < 600, '关掉排队时不该等')
    // 别的两类排队参数没被这条改动带跑
    assert.equal(water.queueLimitsFor('canvas_gen').waitMs, 90000)
    assert.equal(water.queueLimitsFor('review').waitMs, 60000)
  } finally {
    release()
    config.credits.runQueue = saved
  }
})

function mockReq({ method = 'GET', body = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
  }
  return res
}

const cookieOf = () => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.8.9' }).token).split(';')[0]

test('路由：GET /api/runs/queue 带回整机的队与我的名次，票号不出现在响应里', async () => {
  const router = createFlowsRouter()
  const call = async (target) => {
    const res = mockRes()
    const url = new URL('http://127.0.0.1:8899' + target)
    const handled = await router.handle(mockReq({ cookie: cookieOf() }), res, url, url.pathname)
    assert.equal(handled, true, target + ' 必须被运行路由接住')
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
  }

  const idle = await call('/api/runs/queue')
  assert.equal(idle.status, 200)
  assert.equal(idle.json.ok, true)
  assert.equal(idle.json.kind, 'flow_run')
  assert.equal(idle.json.position, null)
  assert.equal(idle.json.waitMs, 4000)

  const release = await holdFullCap()
  const pending = water.admitWaiting('flow_run', { ticket: 'route-run-ticket' })
  try {
    await sleep(180)
    const mine = await call('/api/runs/queue?ticket=route-run-ticket')
    assert.equal(mine.status, 200)
    assert.equal(mine.json.position, 1)
    assert.equal(mine.json.waiting, 1)
    assert.equal(mine.json.scope, 'lease')
    // 票号是凭据：响应里不该把它抄回来
    assert.equal(JSON.stringify(mine.json).includes('route-run-ticket'), false)
    const other = await call('/api/runs/queue?ticket=nobody-knows-this')
    assert.equal(other.json.position, null)
    assert.equal(other.json.waiting, 1)
  } finally {
    release()
    const got = await pending
    got.lease?.release()
  }
})

// 没配评审图片的 review 节点会在调上游之前就失败：用它当「跑得完、不花钱」的流程，
// 这样这一条只验钱与名次，不碰任何真实模型。
const failingFlow = () => [{ id: 'rv', type: 'review', data: { title: '视觉评审', config: { profile: 'brand', image: '' } } }]

test('路由：运行排队期间不扣积分，排到后响应头带名次、流里第一条是 run-queue', async () => {
  const flow = await flows.createFlow({ name: '运行排队用例', nodes: failingFlow(), edges: [] }, user)
  const router = createFlowsRouter()
  const before = balance()
  const chargesBefore = ledgerRows('flow_run').length
  const release = await holdFullCap()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  const pending = router.handle(
    mockReq({
      method: 'POST',
      cookie: cookieOf(),
      headers: { 'content-type': 'application/json', 'x-vq-queue-ticket': 'route-run-post' },
      body: { stream: true },
    }),
    res,
    new URL('http://127.0.0.1' + target),
    target,
  )
  try {
    await sleep(220)
    // 排队中：名次查得到，钱一分没动，流里还什么都没有（响应头要等排到才发）
    assert.equal(water.queueView('flow_run', 'route-run-post').position, 1)
    assert.equal(balance(), before, '排队期间不能扣积分')
    assert.equal(ledgerRows('flow_run').length, chargesBefore, '排队期间不能有这条运行的扣费单')
    assert.equal(res.statusCode, 0)
    assert.equal(res.body, '')

    release()
    await pending
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-vq-queue-position'], '1')
    assert.ok(Number(res.headers['x-vq-queue-waited-ms']) >= 150, '响应头要带真实等待时长')
    const lines = res.body.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines[0].type, 'run-queue', '排过队的第一条事件必须是 run-queue')
    assert.equal(lines[0].position, 1)
    assert.ok(lines[0].waitedMs >= 150)
    assert.equal(lines[1].type, 'run-start')
    const end = lines.find((event) => event.type === 'run-end')
    assert.ok(end, '流里要有 run-end')
    // 排到之后才扣费：账本里正好一张扣费单（这条流程的节点失败，随后全额退回）
    const runId = end.run.id
    // 排队时长要跟着终态记录走：runFlow 会用自己造的对象覆盖占位记录，
    // 这里漏接的话页面就只剩节点耗时，用户等的那段时间凭空消失（v0.9.100）
    assert.ok(Number(end.run.queuedMs) >= 150, '终态记录要带真实排队时长，拿到的是 ' + end.run.queuedMs)
    assert.ok(end.run.queuedAt, '排队开始的时刻也要留着')
    const saved = await flows.getRun(runId, user)
    assert.equal(saved.queuedMs, end.run.queuedMs, '落盘的终态记录与流里返回的是同一个数')
    assert.equal(saved.queuedAt, end.run.queuedAt)
    assert.ok(saved.startedAt >= saved.queuedAt)
    const charges = ledgerRows('flow_run').filter((row) => row.ref === runId)
    assert.equal(charges.length, 1, '排到后只扣一次')
    assert.equal(balance(), before, '节点失败要全额退回，余额回到原值')
    assert.equal(water.queueView('flow_run').waiting, 0)
  } finally {
    release()
  }
})

test('运行摘要也带排队时长：作品页与运行记录用同一个数', () => {
  const summary = flows.runSummary({
    id: 'run_demo',
    flowId: 'flow_demo',
    flowName: '演示画布',
    status: 'success',
    startedAt: '2026-11-14T05:00:00.000Z',
    finishedAt: '2026-11-14T05:00:07.000Z',
    durationMs: 7000,
    queuedMs: 8200,
    total: 3,
  })
  assert.equal(summary.durationMs, 7000)
  assert.equal(summary.queuedMs, 8200)
  // 升级前的记录没有这个字段：摘要写 0，页面据此只说「运行」，不编一个等待时长
  assert.equal(flows.runSummary({ status: 'success', durationMs: 1200 }).queuedMs, 0)
})
