// 排队中可以自己退队（v0.9.97）。v0.9.80~v0.9.96 的三条队（画布出图 / 评审 / 运行）都只回答了
// 「排第几、等了多久」，没有回答「我不想等了怎么办」——用户只能关掉页面。这一组盯住五件事：
//   1) 客户端断开 = 退出排队：返回 499、不占名额、不写响应；
//   2) 退队即让位：后面那张票的名次立刻前进一位（整机一条队，不是各自进程里各排各的）；
//   3) 队满时退队会放出一个位置：原来「排不进来了」的那一条可以进来了；
//   4) 退队只影响自己那张票：同队里排到的那一条照常进门，等待时长是真的；
//   5) 路由层：运行排队中取消 → 不扣积分、不写运行记录、队里清零，响应一个字节都不写。
// 假上游不参与：这一组只测「进门之前」，一次模型调用都不发。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-queue-cancel-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-queue-cancel'
process.env.VQ_RUN_QUEUE_MS = '4000'
process.env.VQ_RUN_QUEUE_MAX = '2'
process.env.VISION_API_KEY = ''
isolateLeaseDir('vq-lease-queue-cancel-')

const { config } = await import('../server/config.mjs')
// 阈值写成 0 等于关掉水位那一条：这组测的是「退队」，不是「这台机器的内存」
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const flows = await import('../server/flows.mjs')
const { createFlowsRouter } = await import('../server/routes/flows.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const user = auth.createUser({ email: '[EMAIL:Q9T3XK]', password: 'Passw0rd!demo', name: '退队', kind: 'member' })
const balance = () => credits.balanceOf(user.id)
const ledgerRows = (kind) => credits.ledgerOf(user.id, 50).filter((row) => row.kind === kind)

/** 把整机的三条重活名额占满（占满才有得排）。返回放掉它们的函数。 */
async function holdFullCap(kind = 'flow_run') {
  const held = []
  for (let i = 0; i < 3; i += 1) {
    const got = lease.acquireHeavyLease(kind, { limit: 3, kindLimit: 0 })
    assert.equal(got.ok, true, '第 ' + (i + 1) + ' 条名额应该拿得到')
    held.push(got.lease)
  }
  return () => {
    for (const item of held) {
      try { item.release() } catch { /* 已经放掉 */ }
    }
  }
}

/** 等到条件成立；超时就断言失败，别把「等不到」写成通过。 */
async function until(check, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) assert.fail('等了 ' + ms + 'ms 还没出现：' + what)
    await sleep(60)
  }
}

test('「人还在不在」只看响应侧：连接没写完就关了算走了，正常写完不算', () => {
  const make = () => {
    const handlers = {}
    const res = {
      writableEnded: false,
      destroyed: false,
      on(name, fn) { handlers[name] = fn; return res },
    }
    return { res, handlers }
  }

  // 1) 连接在响应写完之前被关掉：人走了
  const live = make()
  const gone = water.watchClientGone(live.res)
  assert.equal(gone(), false, '刚接上时人还在')
  live.handlers.close()
  assert.equal(gone(), true, 'close 在 writableEnded 还是 false 时触发 = 客户端断开')

  // 2) 响应正常写完再关：不是取消，别把正常结束当成退队
  const done = make()
  const doneGone = water.watchClientGone(done.res)
  done.res.writableEnded = true
  done.handlers.close()
  assert.equal(doneGone(), false)

  // 3) 直接被 destroy：也是走了
  const killed = make()
  const killedGone = water.watchClientGone(killed.res)
  killed.res.destroyed = true
  assert.equal(killedGone(), true)
})

test('退队即让位：前一张票走了，后一张的名次立刻前进一位', async () => {
  const release = await holdFullCap()
  let aGone = false
  const first = water.admitWaiting('flow_run', { ticket: 'cancel-a', isAborted: () => aGone })
  let second = null
  try {
    await sleep(160)
    second = water.admitWaiting('flow_run', { ticket: 'cancel-b' })
    await sleep(220)
    assert.equal(water.queueView('flow_run', 'cancel-a').position, 1)
    assert.equal(water.queueView('flow_run', 'cancel-b').position, 2)
    assert.equal(water.queueView('flow_run').waiting, 2)

    aGone = true
    const gotA = await first
    assert.equal(gotA.ok, false)
    assert.equal(gotA.aborted, true)
    assert.equal(gotA.status, 499)
    assert.equal(gotA.lease, null)

    // 退队之后不是「还占着第一位」：后面那张立刻变成第 1 位，整机在等的只剩 1 条
    await until(() => water.queueView('flow_run', 'cancel-b').position === 1, 2000, '后一张票升到第 1 位')
    assert.equal(water.queueView('flow_run').waiting, 1)
    // 名额一条没多占：走的这一单什么也没留下
    assert.equal(lease.heavyLeaseSnapshot().total, 3)

    release()
    const gotB = await second
    assert.equal(gotB.ok, true, '排到的那一条照常进门')
    assert.equal(gotB.queued, true)
    assert.ok(gotB.waitedMs >= 150, '等了 ' + gotB.waitedMs + 'ms')
    assert.equal(lease.heavyLeaseSnapshot().total, 1)
    gotB.lease?.release()
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

test('队满时退队会放出一个位置：本来「排不进来了」的那一条可以进来', async () => {
  const saved = config.credits.runQueue
  config.credits.runQueue = { waitMs: 4000, maxWaiting: 1 }
  const release = await holdFullCap()
  let aGone = false
  const holder = water.admitWaiting('flow_run', { ticket: 'full-holder', isAborted: () => aGone })
  let late = null
  try {
    await sleep(160)
    // 位置只有一个，后来者直接拒（不是等，也不是排）
    const refused = await water.admitWaiting('flow_run', { ticket: 'full-late' })
    assert.equal(refused.ok, false)
    assert.equal(refused.queueFull, true)
    assert.equal(refused.status, 503)

    // 占着那一位的人退队：位置空出来，后来者这次排得进来
    aGone = true
    const gotHolder = await holder
    assert.equal(gotHolder.aborted, true)
    await until(() => water.queueView('flow_run').waiting === 0, 2000, '退队后队里清零')
    late = water.admitWaiting('flow_run', { ticket: 'full-again' })
    await sleep(200)
    assert.equal(water.queueView('flow_run', 'full-again').position, 1, '退队腾出的位置要能被下一个人用上')

    release()
    const gotLate = await late
    assert.equal(gotLate.ok, true)
    gotLate.lease?.release()
  } finally {
    release()
    config.credits.runQueue = saved
    for (const pending of [holder, late]) {
      if (!pending) continue
      const leftover = await Promise.race([pending, sleep(50).then(() => null)])
      if (leftover && leftover.lease) leftover.lease.release()
    }
  }
})

test('评审那一类同样退得掉：票退掉、名额不动、状态码是 499', async () => {
  const saved = config.credits.reviewQueue
  config.credits.reviewQueue = { waitMs: 4000, maxWaiting: 2 }
  const release = await holdFullCap('review')
  let gone = false
  const pending = water.admitWaiting('review', { ticket: 'review-cancel', isAborted: () => gone })
  try {
    await sleep(140)
    assert.equal(water.queueView('review', 'review-cancel').position, 1)
    gone = true
    const got = await pending
    assert.equal(got.ok, false)
    assert.equal(got.aborted, true)
    assert.equal(got.status, 499)
    assert.equal(got.body.code, 'CLIENT_GONE')
    assert.equal(lease.heavyLeaseSnapshot().total, 3, '退队不占名额')
    assert.equal(water.queueView('review').waiting, 0)
    assert.equal(water.queueView('review', 'review-cancel').position, null)
  } finally {
    release()
    config.credits.reviewQueue = saved
    const leftover = await Promise.race([pending, sleep(50).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
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

/**
 * 假 res：能像真响应一样派发 'close'。
 * 浏览器点「取消排队」= 关掉连接，服务端看到的是 close 而且 writableEnded 还是 false。
 * 这里不写 statusCode，用来断言「取消之后一个字节都不写」。
 */
function mockRes() {
  const emitter = new EventEmitter()
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    on(name, fn) { emitter.on(name, fn); return res },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
    destroy() { this.destroyed = true; emitter.emit('close') },
  }
  res.abort = () => { emitter.emit('close') }
  return res
}

const cookieOf = () => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.9.1' }).token).split(';')[0]

test('路由：运行排队中点取消 = 不写响应、不扣积分、不写运行记录、队里清零', async () => {
  const flow = await flows.createFlow({ name: '取消排队用例', nodes: [{ id: 'out', type: 'output', data: { title: '输出', config: {} } }], edges: [] }, user)
  const router = createFlowsRouter()
  const before = balance()
  const chargesBefore = ledgerRows('flow_run').length
  const runsBefore = (await flows.listRuns({ flowId: flow.id }, user)).total
  const release = await holdFullCap()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  const pending = router.handle(
    mockReq({
      method: 'POST',
      cookie: cookieOf(),
      headers: { 'content-type': 'application/json', 'x-vq-queue-ticket': 'road-cancel' },
      body: { stream: true },
    }),
    res,
    new URL('http://127.0.0.1' + target),
    target,
  )
  try {
    await sleep(240)
    // 排队中：名次查得到，什么都还没发生
    assert.equal(water.queueView('flow_run', 'road-cancel').position, 1)
    assert.equal(res.statusCode, 0, '排队期间不发响应头')
    assert.equal(balance(), before)

    // 用户点了「取消」：连接关掉，服务端退出排队
    res.abort()
    await pending
    assert.equal(res.statusCode, 0, '取消之后不该再写响应')
    assert.equal(res.body, '')
    assert.equal(res.writableEnded, false)
    // 钱没动、扣费单没有、占位运行记录撤掉、队里清零
    assert.equal(balance(), before, '取消排队不能扣积分')
    assert.equal(ledgerRows('flow_run').length, chargesBefore)
    assert.equal((await flows.listRuns({ flowId: flow.id }, user)).total, runsBefore, '取消之后不该留下一条运行记录')
    assert.equal(water.queueView('flow_run').waiting, 0)
    assert.equal(lease.heavyLeaseSnapshot().total, 3, '取消不占名额')
  } finally {
    release()
    const leftover = await Promise.race([pending, sleep(50).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
  }
})

test('取消之后名额空出来时，下一条运行照常进门（退队不影响别人）', async () => {
  const flow = await flows.createFlow({ name: '取消后排到', nodes: [{ id: 'out', type: 'output', data: { title: '输出', config: {} } }], edges: [] }, user)
  const router = createFlowsRouter()
  const release = await holdFullCap()
  const res = mockRes()
  const target = '/api/flows/' + flow.id + '/run'
  const pending = router.handle(
    mockReq({
      method: 'POST',
      cookie: cookieOf(),
      headers: { 'content-type': 'application/json', 'x-vq-queue-ticket': 'road-cancel-then-run' },
      body: { stream: true },
    }),
    res,
    new URL('http://127.0.0.1' + target),
    target,
  )
  try {
    await sleep(220)
    res.abort()
    await pending
    assert.equal(water.queueView('flow_run').waiting, 0)
    // 取消之后这张票就该从队里消失：不查不到 = 没退干净
    assert.equal(water.queueView('flow_run', 'road-cancel-then-run').position, null)
    // 取消这一单没排队位残留：同一张票再进来是全新的一单（第 1 位，不是「已经在队里」）
    const again = water.admitWaiting('flow_run', { ticket: 'road-cancel-then-run' })
    await sleep(160)
    assert.equal(water.queueView('flow_run', 'road-cancel-then-run').position, 1)
    release()
    const got = await again
    assert.equal(got.ok, true)
    got.lease?.release()
  } finally {
    release()
    const leftover = await Promise.race([pending, sleep(50).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
  }
})
