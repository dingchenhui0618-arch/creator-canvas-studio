// 平台出图通道的名额闸门（v0.9.79）。这一组盯住四件事：
//   1) 名额占满时，通道在**调上游之前**就回 503 —— 上游调用数必须是 0（这单没花钱）；
//   2) 名额是分层的：整机总名额（3 条）与「画布出图这一类」的整机上限（默认 2 条）分开报；
//   3) 计数跨进程：另一个进程占着画布出图的名额，本进程的请求照样被拒；
//   4) 请求结束后名额立刻还回去，不会每跑一张就少一个名额。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isolateLeaseDir } from './lease-isolation.mjs'
import { holdInChild, stopChild } from './lease-child.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-gw-heavy-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-gateway-heavy'
process.env.VQ_GATEWAY_TOKEN = 'test-gateway-token'
process.env.VQ_GATEWAY_OPEN = '1'
// 这一组要的是「排满就拒」本身（v0.9.79 的行为）；排队那层在 gateway-queue.test.mjs 里单独验
process.env.VQ_CANVAS_QUEUE_MS = '0'
process.env.VISION_API_KEY = ''
// 名额按测试文件各算各的（测试文件是各自独立的进程）
isolateLeaseDir('vq-lease-gw-heavy-')

const { config } = await import('../server/config.mjs')
// 阈值写成 0 等于关掉那一条：这组测的是「名额」，不是「这台机器的内存」，判定必须稳定
Object.assign(config.waterline, { tightAvailableMb: 0, criticalAvailableMb: 0, tightHeapPercent: 0, criticalHeapPercent: 0 })

const water = await import('../server/waterline.mjs')
const lease = await import('../server/heavy-lease.mjs')
const { createGatewayRouter } = await import('../server/routes/gateway.mjs')
const { createKey, deleteKey } = await import('../server/keyvault.mjs')
const { rateLimit } = await import('../server/ratelimit.mjs')

// 假上游：记下被调用了几次、同时在跑几条。名额闸门要是没生效，这里就会看到 1 次以上的调用。
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
      res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/canvas-' + upstream.calls + '.png' }] }))
    }, 120)
  })
})
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + fake.address().port
test.after(() => new Promise((resolve) => fake.close(resolve)))

const key = createKey({
  name: '压测出图',
  provider: 'cgcm',
  baseUrl: base + '/seeapi',
  apiKey: 'sk-gw-heavy-1234567890',
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

function gatewayReq({ body = { model: 'image-2-pro', prompt: '压测一张图' }, token = 'test-gateway-token' } = {}) {
  const req = new Readable({ read() {} })
  req.method = 'POST'
  req.headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(JSON.stringify(body))
  req.push(null)
  return req
}

const IMAGE_PATH = '/api/gateway/v1/images/generations'
const call = async (pathname = IMAGE_PATH, options) => {
  const router = createGatewayRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + pathname)
  await router.handle(gatewayReq(options), res, url, url.pathname)
  return res
}

test('画布出图：同类名额排满时调上游之前就 503，一次上游请求都不发', async () => {
  assert.equal(water.kindLimitFor('canvas_gen', 'ok', true), 2, '默认同一时刻最多 2 张在生成')
  // 先在本进程占满「画布出图」的整机名额（总名额 3 还空着一条）
  const held = []
  try {
    for (let i = 0; i < 2; i += 1) {
      const got = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 2 })
      assert.equal(got.ok, true, '第 ' + (i + 1) + ' 张应该占得到名额')
      held.push(got.lease)
    }
    const refused = lease.acquireHeavyLease('canvas_gen', { limit: 3, kindLimit: 2 })
    assert.equal(refused.ok, false)
    assert.equal(refused.kindFull, true, '这次拒的是「同类排满」，不是整机排满')
    assert.equal(refused.full, false)
    assert.equal(refused.active, 2)
    assert.equal(refused.kindLimit, 2)

    upstream.calls = 0
    const res = await call(IMAGE_PATH)
    assert.equal(res.statusCode, 503)
    const payload = JSON.parse(res.body)
    assert.equal(payload.code, 'SERVER_BUSY')
    assert.equal(payload.kind, 'canvas_gen')
    assert.equal(payload.active, 2)
    assert.match(payload.error, /没有产生费用/)
    assert.match(payload.error, /等一分钟/)
    assert.equal(upstream.calls, 0, '被拒的这次绝不能碰到上游（否则就是白花的钱）')
  } finally {
    for (const item of held) item.release()
  }
})

test('名额还回来之后同一张能正常生成，跑完立刻归还', async () => {
  upstream.calls = 0
  const res = await call(IMAGE_PATH)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.urls, ['https://example.invalid/canvas-1.png'])
  assert.equal(upstream.calls, 1)
  // 名额要还回去：不能每跑一张就少一个
  assert.equal(lease.heavyLeaseStatus().total, 0)
  assert.equal(water.waterlineReport().heavy.active, 0)
})

test('整机总名额排满时也是这条通道先拒，且说清是「整机满」不是「同类满」', async () => {
  const held = []
  try {
    // 用别类重活占满整机 3 条：画布出图这一类自己一条都没占
    for (let i = 0; i < 3; i += 1) held.push(lease.acquireHeavyLease('review', { limit: 3 }).lease)
    upstream.calls = 0
    const res = await call(IMAGE_PATH)
    assert.equal(res.statusCode, 503)
    const payload = JSON.parse(res.body)
    assert.equal(payload.code, 'SERVER_BUSY')
    assert.equal(payload.active, 3)
    assert.equal(payload.limit, 3)
    assert.equal(payload.kind, undefined, '整机满的时候不该说成「画布出图这一类满」')
    assert.equal(upstream.calls, 0)
  } finally {
    for (const item of held) item.release()
  }
})

test('计数跨进程：另一个进程占着画布出图的名额，本进程一样被拒', async () => {
  const child = holdInChild({ count: 2, kind: 'canvas_gen', limit: 0 })
  try {
    await child.ready
    upstream.calls = 0
    const res = await call(IMAGE_PATH)
    assert.equal(res.statusCode, 503)
    const payload = JSON.parse(res.body)
    assert.equal(payload.code, 'SERVER_BUSY')
    assert.equal(payload.active, 2)
    assert.equal(upstream.calls, 0)
    // 预检要说清是哪一层排满：同类满，整机没满
    const precheck = water.admissionCheck('canvas_gen')
    assert.equal(precheck.ok, false)
    assert.equal(precheck.kindFull, true)
    assert.equal(precheck.kindActive, 2)
    assert.equal(precheck.kindLimit, 2)
  } finally {
    await stopChild(child.child)
  }
  // 子进程被 kill 掉：名额靠 pid 存活判定立刻回收，不用等 TTL
  assert.equal(water.admissionCheck('canvas_gen').ok, true)
  assert.equal(lease.heavyLeaseStatus().total, 0)
})

test('入口限流：出图通道一分钟 20 次，第 21 次 429（这不是名额，是花钱速度的刹车）', () => {
  const ip = '10.9.9.77'
  for (let i = 0; i < 20; i += 1) {
    assert.equal(rateLimit({ method: 'POST' }, '/api/gateway/v1/images/generations', ip), null, '第 ' + (i + 1) + ' 次应该放行')
  }
  const limited = rateLimit({ method: 'POST' }, '/api/gateway/v1/images/generations', ip)
  assert.ok(limited, '第 21 次要被限流')
  assert.equal(limited.bucket, 'gateway')
  assert.ok(limited.retryAfterSec >= 1)
  // 读接口（探活 / 轮询任务）不跟着限：它们不花上游的钱
  assert.equal(rateLimit({ method: 'GET' }, '/api/gateway/v1/models', ip), null)
})

test('令牌不对仍然先 401：名额闸门不会把鉴权挡在后面', async () => {
  const res = await call(IMAGE_PATH, { token: 'wrong-token' })
  assert.equal(res.statusCode, 401)
  assert.equal(JSON.parse(res.body).code, 'GATEWAY_UNAUTHORIZED')
})
