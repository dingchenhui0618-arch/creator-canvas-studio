// 画布出图的排队位可见（v0.9.83）。v0.9.80 会排队，但只有一条连接在等——画布上什么也看不到，
// 后台也只数「几条在等」。这一组盯六件事：
//   1) 排队那一刻就能问出「我排第几、前面还有几张」，名次按入场顺序；
//   2) 票号由调用方带（画布可以用节点 id / 幂等键），响应头把它与入场名次还回去；
//   3) 聚合视图（画布页状态条 / 后台卡片读的那份）不含票号，只有序号与等待时长；
//   4) 排满 / 等超时 / 客户端断开，票都要划掉，名次不能残留；
//   5) 排队票只对画布出图这一类有意义，别的重活没有名次；
//   6) 两个读接口都有人守：画布页那条要登录，画布服务那条要平台令牌。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-canvas-queue-visible-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-canvas-queue-visible'
process.env.VQ_GATEWAY_TOKEN = 'test-gateway-token'
process.env.VQ_GATEWAY_OPEN = '1'
process.env.VISION_API_KEY = ''
isolateLeaseDir('vq-lease-cq-visible-')

const { config } = await import('../server/config.mjs')
// 阈值写 0 = 关掉那一条：这组测的是排队位，不是这台机器的内存
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })

const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const auth = await import('../server/auth.mjs')
const { createGatewayRouter } = await import('../server/routes/gateway.mjs')
const { createCanvasRouter } = await import('../server/routes/canvas.mjs')
const { createKey, deleteKey } = await import('../server/keyvault.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const queue = () => water.admissionQueueReport('canvas_gen')

// 假上游：延迟 120ms 回一张图，只数调用次数（排队位这一层不该碰它）
const upstream = { calls: 0 }
const fake = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    upstream.calls += 1
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/visible-' + upstream.calls + '.png' }] }))
    }, 120)
  })
})
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + fake.address().port
test.after(() => new Promise((resolve) => fake.close(resolve)))

const key = createKey({
  name: '排队可见出图',
  provider: 'cgcm',
  baseUrl: base + '/seeapi',
  apiKey: 'sk-gw-visible-1234567890',
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

// 画布提前断开的模拟：真实 ServerResponse 断开时会先发 'close'，再把 destroyed 置真
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

function gatewayReq({ method = 'POST', headers = {}, body = { model: 'image-2-pro', prompt: '排队可见' } } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { authorization: 'Bearer test-gateway-token', 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (method !== 'GET') req.push(JSON.stringify(body))
  req.push(null)
  return req
}

const IMAGE_PATH = '/api/gateway/v1/images/generations'
async function callImage({ ticket = '', res = mockRes() } = {}) {
  const router = createGatewayRouter()
  const url = new URL('http://127.0.0.1' + IMAGE_PATH)
  const headers = ticket ? { 'x-vq-queue-ticket': ticket } : {}
  await router.handle(gatewayReq({ headers }), res, url, url.pathname)
  return res
}

async function callQueueEndpoint({ token = 'test-gateway-token', ticket = '' } = {}) {
  const router = createGatewayRouter()
  const target = '/api/gateway/v1/queue' + (ticket ? '?ticket=' + encodeURIComponent(ticket) : '')
  const url = new URL('http://127.0.0.1' + target)
  const res = mockRes()
  await router.handle(gatewayReq({ method: 'GET', headers: token ? { authorization: 'Bearer ' + token } : { authorization: '' } }), res, url, url.pathname)
  return res
}

// 每个用例自己定这一轮的闸门参数：默认「整机只放 1 张、最多 4 条在等、每条最多等 5 秒」
function arm({ limit = 1, waitMs = 5000, maxWaiting = 4 } = {}) {
  config.credits.concurrency.canvas_gen = limit
  config.credits.canvasQueue.waitMs = waitMs
  config.credits.canvasQueue.maxWaiting = maxWaiting
}

test('排队那一刻就知道自己第几：三张一起进来，名次 1 / 2 / 3，聚合视图里没有票号', async () => {
  arm()
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  assert.equal(held.ok, true)
  upstream.calls = 0
  const before = queue().served
  const pending = [callImage({ ticket: 't-1' }), callImage({ ticket: 't-2' }), callImage({ ticket: 't-3' })]
  await sleep(220)

  const report = queue()
  assert.equal(report.waiting, 3, '三条都该在排队位里：' + JSON.stringify(report))
  assert.deepEqual(report.queue.map((slot) => slot.position), [1, 2, 3], '名次按入场顺序')
  assert.ok(report.oldestWaitMs >= 150, '最久的那条要能算出等了多久：' + report.oldestWaitMs)

  const mine = water.queuePositionFor('canvas_gen', 't-2')
  assert.equal(mine.position, 2)
  assert.equal(mine.ahead, 1, '前面还有一张')
  assert.equal(mine.waiting, 3)
  assert.ok(mine.waitedMs > 0)

  const view = water.canvasQueueView()
  assert.equal(view.waiting, 3)
  assert.ok(view.active >= 1, '占住名额的那条算在「在跑」里：' + view.active)
  assert.equal(view.mine, undefined, '不点名票号就不回「我排第几」')
  assert.equal(JSON.stringify(view).includes('"ticket"'), false, '聚合视图不许带票号：' + JSON.stringify(view))
  assert.deepEqual(view.queue.map((slot) => slot.position), [1, 2, 3])
  assert.equal(water.canvasQueueView({ ticket: 't-3' }).mine.position, 3, '点名了才回自己的名次')

  held.lease.release()
  const done = await Promise.all(pending)
  assert.deepEqual(done.map((res) => res.statusCode), [200, 200, 200], '排到之后照常出图')
  assert.equal(upstream.calls, 3)
  assert.equal(queue().waiting, 0, '排完立刻从排队位里出来')
  assert.equal(queue().served - before, 3)
  assert.equal(water.queuePositionFor('canvas_gen', 't-2'), null, '排到之后票就不在队里了')
})

test('响应头把票号与入场名次还回去（画布据此继续问「我排第几」）', async () => {
  arm()
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const pending = callImage({ ticket: 'node-7' })
  await sleep(150)
  assert.equal(water.queuePositionFor('canvas_gen', 'node-7').position, 1)
  setTimeout(() => held.lease.release(), 200)
  const res = await pending
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['X-VQ-Queue-Ticket'], 'node-7', '票号还回去：' + JSON.stringify(res.headers))
  assert.equal(res.headers['X-VQ-Queue-Position'], '1', '入场名次一起回去')
  assert.ok(Number(res.headers['X-VQ-Queue-Ms']) > 0, '等了多久还是那条老响应头')
  assert.equal(upstream.calls, 1)
})

test('排队位满了：新来的立刻拒、不留名次，视图里 full=true', async () => {
  arm({ maxWaiting: 1 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const waitingOne = callImage({ ticket: 'first' })
  await sleep(150)
  assert.equal(queue().waiting, 1)
  const refused = await callImage({ ticket: 'late' })
  assert.equal(refused.statusCode, 503)
  assert.equal(JSON.parse(refused.body).queueFull, true)
  assert.equal(water.queuePositionFor('canvas_gen', 'late'), null, '被拒的那张不该占一个名次')
  assert.equal(water.canvasQueueView().full, true, '排队位满了这一点要能被画布看到')
  held.lease.release()
  assert.equal((await waitingOne).statusCode, 200)
})

test('等超时的票要划掉：名次不残留、上游一次没碰', async () => {
  arm({ waitMs: 300 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const before = queue().timedOut
  const res = await callImage({ ticket: 'slow-1' })
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).timedOut, true)
  assert.equal(queue().timedOut - before, 1)
  assert.equal(queue().waiting, 0)
  assert.equal(water.queuePositionFor('canvas_gen', 'slow-1'), null)
  assert.equal(upstream.calls, 0, '超时发生在调上游之前')
  held.lease.release()
})

test('客户端断开：票马上划掉，别的请求不会被它堵住', async () => {
  arm({ waitMs: 5000 })
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  upstream.calls = 0
  const res = abortableRes()
  const pending = callImage({ ticket: 'gone-1', res })
  await sleep(150)
  assert.equal(water.queuePositionFor('canvas_gen', 'gone-1').position, 1)
  res.triggerClose()
  await pending
  assert.equal(queue().waiting, 0, '断开也要把名次收回来')
  assert.equal(water.queuePositionFor('canvas_gen', 'gone-1'), null)
  assert.equal(upstream.calls, 0)
  held.lease.release()
})

test('只有画布出图有名次：别的重活既不排队也没有「我第几」', () => {
  assert.equal(water.queueLimitsFor('review').waitMs, 0)
  assert.equal(water.queuePositionFor('review', 'whatever'), null)
  const view = water.canvasQueueView()
  assert.equal(view.kind, 'canvas_gen')
  assert.equal(view.queueScope, 'process', '排队位现在是本进程的（两个实例各排各的），这一点要写在响应里')
  assert.equal(typeof view.scope, 'string')
})

test('GET /api/gateway/v1/queue：平台令牌是门槛，点名票号才回「我排第几」', async () => {
  arm()
  const held = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 1 })
  const pending = callImage({ ticket: 'q-1' })
  await sleep(150)

  const denied = await callQueueEndpoint({ token: '' })
  assert.equal(denied.statusCode, 401, '没令牌不给读')

  const plain = await callQueueEndpoint()
  assert.equal(plain.statusCode, 200)
  const plainBody = JSON.parse(plain.body)
  assert.equal(plainBody.waiting, 1)
  assert.equal(plainBody.mine, undefined)
  assert.equal(JSON.stringify(plainBody).includes('"ticket"'), false)

  const mine = JSON.parse((await callQueueEndpoint({ ticket: 'q-1' })).body)
  assert.equal(mine.mine.position, 1)
  assert.equal(mine.mine.waitedMs > 0, true)

  held.lease.release()
  await pending
  assert.equal(queue().waiting, 0)
})

test('GET /api/canvas/queue：画布页那条要登录，回的是同一份聚合数、没有票号', async () => {
  const router = createCanvasRouter()
  const target = '/api/canvas/queue'
  const anon = mockRes()
  await router.handle(gatewayReq({ method: 'GET', headers: { authorization: '' } }), anon, new URL('http://127.0.0.1' + target), target)
  assert.equal(anon.statusCode, 401)
  assert.equal(JSON.parse(anon.body).loginRequired, true)

  const user = auth.createUser({ email: '[EMAIL:CQVIS1]', password: 'Passw0rd!demo', name: '排队可见', kind: 'user' })
  const cookie = auth.sessionCookie(auth.createSession(user).token).split(';')[0]
  const res = mockRes()
  await router.handle(gatewayReq({ method: 'GET', headers: { authorization: '', cookie } }), res, new URL('http://127.0.0.1' + target), target)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.kind, 'canvas_gen')
  assert.equal(typeof body.waiting, 'number')
  assert.equal(typeof body.oldestWaitMs, 'number')
  assert.equal(typeof body.waitMs, 'number')
  assert.equal(typeof body.maxWaiting, 'number')
  assert.equal(JSON.stringify(body).includes('"ticket"'), false, '票号不进这条响应：' + res.body)
})
