// 评审的排队位（v0.9.95）。评审是产品的主付费动作：撞上整机的重活上限时，
// 注意：test/review-queue.test.mjs 是「评审待办队列」（哪几条作品还等着人动手），
// 这一组是「名额满时进队等」（machine-wide admission queue）——两个 queue 不是一回事。
// v0.9.79~v0.9.94 一律立刻 503「服务器正忙」，用户只能自己再点一次。这一组盯住六件事：
//   1) 名额满时先排队，排到就进门（不扣积分、不调模型这件事发生在排到之后）；
//   2) 名次是整机口径：同一张票能按票号查到第几，两张票先来后到；
//   3) 排队位本身也有上限：排满了直接拒，不把连接堆在这里；
//   4) 等超时拒绝，而且**始终不占名额、不碰上游**（拒绝发生在扣费之前，这一单不花钱）；
//   5) 客户端提前断开就退出排队，不写响应；
//   6) 关了排队（waitMs / maxWaiting 写 0）退回立刻拒，别的类型不受影响。
// 假上游在这里不参与：这一组只测「进门之前」，一次模型调用都不发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-queue-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-review-queue'
process.env.VQ_REVIEW_QUEUE_MS = '4000'
process.env.VQ_REVIEW_QUEUE_MAX = '2'
process.env.VISION_API_KEY = ''
// 名额与排队位都按这个文件各算各的（测试文件是各自独立的进程）
isolateLeaseDir('vq-lease-review-queue-')

const { config } = await import('../server/config.mjs')
// 阈值写成 0 等于关掉水位那一条：这组测的是「排队」，不是「这台机器的内存」
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })
const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const { createReviewRouter, watchClientGone } = await import('../server/routes/review.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const queue = () => water.queueLimitsFor('review')

/** 把整机的三条重活名额占满（占满才有得排）。返回放掉它们的函数。 */
async function holdFullCap() {
  const held = []
  for (let i = 0; i < 3; i += 1) {
    const got = lease.acquireHeavyLease('review', { limit: 3, kindLimit: 0 })
    assert.equal(got.ok, true, '第 ' + (i + 1) + ' 条名额应该拿得到')
    held.push(got.lease)
  }
  return () => {
    for (const item of held) {
      try { item.release() } catch { /* 已经放掉 */ }
    }
  }
}

test('默认参数：评审 60 秒 / 4 条，画布出图仍是 90 秒 / 8 条，别的类型不排队', () => {
  // 这个进程里 env 覆盖成 4000 / 2：先证明配置真的读到了这一段
  assert.deepEqual(queue(), { waitMs: 4000, maxWaiting: 2 })
  // 画布出图那一段没动（同一份配置里两段分开，改评审不许把画布一起改了）
  assert.deepEqual(water.queueLimitsFor('canvas_gen'), { waitMs: 90000, maxWaiting: 8 })
  // 没配排队位的类型仍然是立刻拒
  assert.deepEqual(water.queueLimitsFor('flow_run'), { waitMs: 0, maxWaiting: 0 })
  assert.deepEqual(water.queueLimitsFor('review_nope'), { waitMs: 0, maxWaiting: 0 })

  // 生产默认值用干净的子进程量一次：本进程的 env 已经被测试改过
  const script = 'import("./server/config.mjs").then((m) => console.log(JSON.stringify(m.config.credits.reviewQueue)))'
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '--experimental-strip-types', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, VQ_REVIEW_QUEUE_MS: '', VQ_REVIEW_QUEUE_MAX: '' },
    encoding: 'utf8',
  })
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { waitMs: 60000, maxWaiting: 4 })
})

test('名额满时先排队：排到就进门，名次与等待时长都是真数', async () => {
  const release = await holdFullCap()
  const ticket = 'review-ticket-one'
  const started = Date.now()
  const pending = water.admitWaiting('review', { ticket })
  try {
    await sleep(220)
    // 排队中：按票号查得到自己是第 1 位，整机 1 条在等
    const view = water.queueView('review', ticket)
    assert.equal(view.position, 1)
    assert.equal(view.ahead, 0)
    assert.equal(view.waiting, 1)
    assert.equal(view.scope, 'lease')
    assert.equal(view.countsScope, 'process')
    assert.equal(view.waitMs, 4000)
    // 还没排到：一条名额都没占（3 条还是别人的）
    assert.equal(lease.heavyLeaseSnapshot().total, 3)

    release()
    const got = await pending
    assert.equal(got.ok, true)
    assert.equal(got.queued, true)
    assert.equal(got.position, 1)
    assert.ok(got.waitedMs >= 150, '等了 ' + got.waitedMs + 'ms，至少要跨过一轮轮询')
    assert.ok(Date.now() - started >= got.waitedMs)
    // 排到之后才占名额、才轮到扣费与调模型
    assert.equal(lease.heavyLeaseSnapshot().total, 1)
    got.lease.release()
    // 进门后票就退出队了：再问名次是 null（页面据此收起「排队中」）
    assert.equal(water.queueView('review', ticket).position, null)
    assert.equal(water.queueView('review').waiting, 0)
  } finally {
    release()
    // 保险：哪一步断言炸了也别把名额留在目录里
    const leftover = await Promise.race([pending, sleep(50).then(() => null)])
    if (leftover && leftover.lease) leftover.lease.release()
  }
})

test('先来先得：两张票的名次是整机的顺序，不是各自进程里的 1', async () => {
  const release = await holdFullCap()
  const first = water.admitWaiting('review', { ticket: 'review-ticket-a' })
  try {
    await sleep(150)
    const second = water.admitWaiting('review', { ticket: 'review-ticket-b' })
    await sleep(200)
    const a = water.queueView('review', 'review-ticket-a')
    const b = water.queueView('review', 'review-ticket-b')
    assert.equal(a.position, 1)
    assert.equal(b.position, 2)
    assert.equal(b.ahead, 1)
    assert.equal(water.queueView('review').waiting, 2)

    release()
    const [ga, gb] = await Promise.all([first, second])
    assert.equal(ga.ok, true)
    assert.equal(gb.ok, true)
    assert.equal(ga.position, 1)
    assert.equal(gb.position, 2)
    ga.lease.release()
    gb.lease.release()
  } finally {
    release()
    const rest = await Promise.race([Promise.all([first]), sleep(50).then(() => null)])
    if (rest) for (const item of rest) item.lease?.release()
  }
})

test('排队位满了直接拒：文案说的是「评审」，不是画布出图的「生成」', async () => {
  const release = await holdFullCap()
  const saved = config.credits.reviewQueue.maxWaiting
  config.credits.reviewQueue.maxWaiting = 1
  const held = water.admitWaiting('review', { ticket: 'review-ticket-hold' })
  try {
    await sleep(180)
    const refused = await water.admitWaiting('review', { ticket: 'review-ticket-refused' })
    assert.equal(refused.ok, false)
    assert.equal(refused.queueFull, true)
    assert.equal(refused.status, 503)
    assert.match(refused.body.error, /评审/)
    assert.match(refused.body.error, /没有扣积分/)
    assert.doesNotMatch(refused.body.error, /生成/)
  } finally {
    config.credits.reviewQueue.maxWaiting = saved
    release()
    const got = await held
    got.lease?.release()
  }
})

test('等超时拒绝：不占名额、不留下队里的票，文案按评审说', async () => {
  const release = await holdFullCap()
  const saved = config.credits.reviewQueue.waitMs
  config.credits.reviewQueue.waitMs = 300
  try {
    const result = await water.admitWaiting('review', { ticket: 'review-ticket-timeout' })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.ok(result.waitedMs >= 250, '等太久要报真实时长：' + result.waitedMs)
    assert.equal(result.body.code, 'SERVER_BUSY')
    assert.match(result.body.error, /评审/)
    assert.match(result.body.error, /没有扣积分/)
    assert.ok(result.body.retryAfterSec > 0)
    // 超时之后：名额还是那 3 条（没有偷偷占一条），队里也没了
    assert.equal(lease.heavyLeaseSnapshot().total, 3)
    assert.equal(water.queueView('review').waiting, 0)
  } finally {
    config.credits.reviewQueue.waitMs = saved
    release()
  }
})

test('客户端提前断开：退出排队，不占名额', async () => {
  const release = await holdFullCap()
  let checks = 0
  try {
    const result = await water.admitWaiting('review', {
      ticket: 'review-ticket-gone',
      isAborted: () => {
        checks += 1
        return checks > 1
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.aborted, true)
    assert.equal(result.status, 499)
    assert.equal(lease.heavyLeaseSnapshot().total, 3)
    assert.equal(water.queueView('review').waiting, 0)
  } finally {
    release()
  }
})

test('关掉排队（waitMs 写 0）退回立刻拒，别的类型不受影响', async () => {
  const release = await holdFullCap()
  const saved = config.credits.reviewQueue.waitMs
  config.credits.reviewQueue.waitMs = 0
  try {
    const result = await water.admitWaiting('review', { ticket: 'review-ticket-off' })
    assert.equal(result.ok, false)
    assert.equal(result.queued, false)
    assert.equal(result.waitedMs, 0)
    assert.equal(result.status, 503)
    // 立刻拒：没有排队记录，也没有等
    assert.equal(water.queueView('review').waiting, 0)
  } finally {
    config.credits.reviewQueue.waitMs = saved
    release()
  }
})

test('客户端断开的判据只看响应侧：请求体读完之后的 req.destroyed 不算「人走了」', () => {
  // 第一版拿 req.destroyed 当判据：请求体一读完它就是 true，每一单评审都在排队第一步退出，
  // 客户端挂在 POST 上等不到任何响应（本地两实例验收当场卡死才发现）。这里把判据钉在响应侧。
  const make = () => {
    const handlers = {}
    const res = { writableEnded: false, destroyed: false, on(event, fn) { handlers[event] = fn } }
    return { res, handlers, gone: watchClientGone(res) }
  }
  const live = make()
  assert.equal(live.gone(), false)
  // 请求体读完是常态：这件事不经过这个判据，所以排队照旧
  live.res.writableEnded = false
  assert.equal(live.gone(), false)
  // 人真的走了：响应在没写完的时候被关掉
  live.handlers.close()
  assert.equal(live.gone(), true)

  const destroyed = make()
  destroyed.res.destroyed = true
  assert.equal(destroyed.gone(), true)

  // 没有 on 的假 res（测试里的老替身）也要能用，不能抛
  assert.equal(watchClientGone({ writableEnded: false, destroyed: false })(), false)
})

test('路由：GET /api/review/queue 带回整机的队与我的名次，票号不出现在响应里', async () => {
  const router = createReviewRouter()
  const call = async (pathname) => {
    const req = Object.assign(Readable.from([]), {
      method: 'GET',
      headers: { host: '127.0.0.1:8899', 'user-agent': 'vq-review-queue-test' },
      socket: { remoteAddress: '203.0.113.9' },
    })
    const res = {
      statusCode: 0,
      headers: {},
      chunks: [],
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}) },
      end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)) },
      get body() { return Buffer.concat(this.chunks).toString('utf8') },
    }
    const url = new URL('http://127.0.0.1:8899' + pathname)
    const handled = await router.handle(req, res, url, pathname.split('?')[0])
    assert.equal(handled, true, pathname + ' 必须被评审路由接住')
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
  }

  const idle = await call('/api/review/queue')
  assert.equal(idle.status, 200)
  assert.equal(idle.json.kind, 'review')
  assert.equal(idle.json.position, null)
  assert.equal(idle.json.waitMs, 4000)

  const release = await holdFullCap()
  const pending = water.admitWaiting('review', { ticket: 'route-ticket' })
  try {
    await sleep(180)
    const mine = await call('/api/review/queue?ticket=route-ticket')
    assert.equal(mine.status, 200)
    assert.equal(mine.json.position, 1)
    assert.equal(mine.json.waiting, 1)
    assert.equal(mine.json.scope, 'lease')
    // 票号是凭据：响应里不该把它抄回来
    assert.equal(JSON.stringify(mine.json).includes('route-ticket'), false)
    const other = await call('/api/review/queue?ticket=nobody-knows-this')
    assert.equal(other.json.position, null)
    assert.equal(other.json.waiting, 1)
  } finally {
    release()
    const got = await pending
    got.lease?.release()
  }
})
