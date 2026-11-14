// 画布出图的排队位（v0.9.80）。v0.9.79 的闸门解决的是「不花钱」，这一组盯的是它的副作用：
//   一次「批量出图」连发 8 张，整机只放 2 张，第 3 张起立刻 503 —— 画布上就是「2 张成功、6 张失败」。
// 画布其实等得起（同步出图超时 1800 秒），所以名额满时先排一会儿。这一组要证明五件事：
//   1) 排队期间名额空出来就照常出图，不是立刻拒；
//   2) 排队位本身也有上限：排满了直接拒（不把连接堆在这里）；
//   3) 等太久会超时拒绝，而且**始终不碰上游**（拒绝发生在调上游之前，这一单不花钱）；
//   4) 客户端提前断开就退出排队，既不写响应也不调上游；
//   5) waitMs 写 0 = 退回 v0.9.79 的立刻拒（那一档要能被关掉）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-gw-queue-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-gateway-queue'
process.env.VQ_GATEWAY_TOKEN = 'test-gateway-token'
process.env.VQ_GATEWAY_OPEN = '1'
process.env.VISION_API_KEY = ''
// 名额与排队位都按测试文件各算各的（测试文件是各自独立的进程）
isolateLeaseDir('vq-lease-gw-queue-')

const { config } = await import('../server/config.mjs')
// 阈值写成 0 等于关掉那一条：这组测的是「排队」，不是「这台机器的内存」
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })

const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const { createGatewayRouter } = await import('../server/routes/gateway.mjs')
const { createKey, deleteKey } = await import('../server/keyvault.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const queue = () => water.admissionQueueReport('canvas_gen')

// 假上游：延迟 120ms 回一张图；只数调用次数——排队期最长的那条要证明自己一次都没发出去。
const upstream = { calls: 0, concurrent: 0, peakConcurrent: 0 }
const fake = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    upstream.calls += 1
    upstream.concurrent += 1
    upstream.peakConcurrent = Math.max(upstream.peakConcurrent, upstream.concurrent)
    setTimeout(() => {
      upstream.concurrent -= 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/queue-' + upstream.calls + '.png' }] }))
    }, 120)
  })
})
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + fake.address().port
test.after(() => new Promise((resolve) => fake.close(resolve)))

const key = createKey({
  name: '排队压测出图',
  provider: 'cgcm',
  baseUrl: base + '/seeapi',
  apiKey: 'sk-gw-queue-1234567890',
  models: ['image-2-pro'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})
test.after(() => deleteKey(key.id))

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

// 画布提前断开的模拟：真实 ServerResponse 断开时会先发 'close' 再把 destroyed 置真
function abortableRes() {
  const res = mockRes()
  res.destroyed = false
  const listeners = []
  res.on = (event, handler) => {
    if (event === 'close') listeners.push(handler)
    return res
  }
  res.triggerClose = () => {
    res.destroyed = true
    for (const handler of listeners) handler()
  }
  return res
}

function gatewayReq({ body = { model: 'image-2-pro', prompt: '排队一张图' }, token = 'test-gateway-token' } = {}) {
  const req = new Readable({ read() {} })
  req.method = 'POST'
  req.headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(JSON.stringify(body))
  req.push(null)
  return req
}

const IMAGE_PATH = '/api/gateway/v1/images/generations'
const call = async (res = mockRes()) => {
  const router = createGatewayRouter()
  const url = new URL('http://127.0.0.1' + IMAGE_PATH)
  await router.handle(gatewayReq(), res, url, url.pathname)
  return res
}

// 每个用例自己定这一轮的闸门参数：默认「整机只放 1 张、最多 4 条在等、每条最多等 5 秒」
function arm({ limit = 1, waitMs = 5000, maxWaiting = 4 } = {}) {
  config.credits.concurrency.canvas_gen = limit
  config.credits.canvasQueue.waitMs = waitMs
  config.credits.canvasQueue.maxWaiting = maxWaiting
}

test('名额满时先排队：名额一空就照常出图，不是立刻拒', async () => {
  arm()
  // 先占住唯一的名额 250ms，模拟「前一张还在生成」
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  assert.equal(held.ok, true)
  upstream.calls = 0
  const started = Date.now()
  const waiter = call()
  await sleep(150)
  assert.equal(queue().waiting, 1, '这时应该有一条在排队')
  setTimeout(() => held.lease.release(), 250)
  const res = await waiter
  const waitedMs = Date.now() - started
  assert.equal(res.statusCode, 200, '排到之后要真的出图')
  assert.ok(Number(res.headers['X-VQ-Queue-Ms']) > 0, '响应头要带回等了多久：' + JSON.stringify(res.headers))
  assert.ok(waitedMs >= 300, '它确实等了一会儿（' + waitedMs + ' ms）')
  assert.equal(upstream.calls, 1, '排队的那一张最后只发了一次上游')
  const report = queue()
  assert.equal(report.waiting, 0, '排完立刻从排队位里出来')
  assert.equal(report.served, 1)
  assert.equal(water.waterlineReport().heavy.active, 0, '名额也还回去了')
})

test('排队位也有上限：排满时立刻拒，不把连接堆在这里', async () => {
  arm({ maxWaiting: 1 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const waiter = call()
  await sleep(120)
  assert.equal(queue().waiting, 1)
  const refused = await call()
  assert.equal(refused.statusCode, 503)
  const payload = JSON.parse(refused.body)
  assert.equal(payload.code, 'SERVER_BUSY')
  assert.equal(payload.queueFull, true, '要说清是「排队位满」，不是「同类满」')
  assert.match(payload.error, /没有产生费用/)
  assert.equal(upstream.calls, 0)
  held.lease.release()
  assert.equal((await waiter).statusCode, 200, '排在里面的那一条照样会排到')
})

test('等太久会超时拒绝，而且全程不碰上游', async () => {
  arm({ waitMs: 300 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const res = await call()
  assert.equal(res.statusCode, 503)
  const payload = JSON.parse(res.body)
  assert.equal(payload.code, 'SERVER_BUSY')
  assert.equal(payload.timedOut, true)
  assert.ok(Number(payload.waitedMs) >= 250, '要说清等了多久：' + payload.waitedMs)
  // 等待时长要写成好读的秒：这次等了约 0.3 秒，不能写成「0 秒」
  assert.match(payload.error, /排队等了 0\.[3-9] 秒/)
  assert.match(payload.error, /没有产生费用/)
  assert.equal(upstream.calls, 0, '排到超时的这一张一次上游都没发（发出去就是钱）')
  assert.equal(queue().timedOut, 1)
  held.lease.release()
})

test('客户端提前断开就退出排队：不写响应、不调上游', async () => {
  arm({ waitMs: 5000 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const res = abortableRes()
  const pending = call(res)
  await sleep(120)
  assert.equal(queue().waiting, 1)
  const closedAt = Date.now()
  res.triggerClose()
  const out = await pending
  assert.ok(Date.now() - closedAt < 1200, '断开后要在下一个轮询点收手，不是等满 5 秒')
  assert.equal(out.statusCode, 0, '客户端已经走了，不要再写响应')
  assert.equal(out.writableEnded, false)
  assert.equal(upstream.calls, 0)
  assert.equal(queue().waiting, 0, '排队位要收回来，不能漏一个名额')
  assert.equal(queue().abandoned, 1)
  held.lease.release()
})

test('waitMs 写 0 = 退回立刻拒（排队这一层可以被关掉）', async () => {
  arm({ waitMs: 0 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const started = Date.now()
  const res = await call()
  assert.equal(res.statusCode, 503)
  assert.ok(Date.now() - started < 600, '关掉排队时不该等')
  const payload = JSON.parse(res.body)
  assert.equal(payload.queued, undefined)
  assert.equal(payload.timedOut, undefined)
  assert.equal(upstream.calls, 0)
  held.lease.release()
})

test('只有画布出图 / 评审 / 运行三类排队：复刻的参数是 0', () => {
  // v0.9.95 起评审也排、v0.9.96 起运行也排（都是默认 60 秒 / 4 条），复刻仍然立刻拒
  assert.equal(water.queueLimitsFor('replicate').waitMs, 0)
  assert.equal(water.queueLimitsFor('flow_run').waitMs, config.credits.runQueue.waitMs)
  assert.equal(water.queueLimitsFor('review').waitMs, config.credits.reviewQueue.waitMs)
  assert.equal(water.queueLimitsFor('review').maxWaiting, config.credits.reviewQueue.maxWaiting)
  assert.equal(water.queueLimitsFor('canvas_gen').waitMs, 0)
  // 上面几条用例改过参数；恢复成默认再验一次
  config.credits.canvasQueue.waitMs = 90000
  config.credits.canvasQueue.maxWaiting = 8
  assert.equal(water.queueLimitsFor('canvas_gen').waitMs, 90000)
  assert.equal(water.queueLimitsFor('canvas_gen').maxWaiting, 8)
  const report = water.waterlineReport().heavy.queue
  assert.equal(report.kind, 'canvas_gen')
  assert.equal(report.waitMs, 90000)
  assert.equal(report.maxWaiting, 8)
  assert.equal(report.waiting, 0)
  assert.equal(typeof report.since, 'string')
})
