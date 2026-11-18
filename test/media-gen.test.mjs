// 智能体页的生图 / 生视频窗口：走本地假上游把「扣费、落盘、鉴权、退款」整条链跑一遍。
// 不调用真实 GeteAPI / SeeAPI，不消耗任何上游额度。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-media-gen-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-media-gen'
process.env.VISION_API_KEY = ''
process.env.VQ_REQUIRE_AUTH = '1'

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)
const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)])

let videoPolls = 0
// 假上游按真实 SeeAPI 的规矩校验：它强制要 aspect_ratio，缺了就是 400 validation_error。
// 2026-11-18 生产上真实踩过这一条（生视频窗口每次 4 秒就失败），所以在假上游里也把它变成硬约束。
let lastVideoBody = null
// 记一次真实打上游的次数：冷却中应当一次都不打，光看错误文案证明不了这一点。
let imageAttempts = 0
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      imageAttempts += 1
      const body = JSON.parse(bodyText || '{}')
      if (String(body.prompt || '').includes('图失败')) {
        return send(500, { error: { code: 'upstream_rejected', message: '上游拒绝这次生图' } })
      }
      return send(200, { created: 1, data: [{ b64_json: 'data:image/png;base64,' + tinyPng.toString('base64') }] })
    }
    if (req.method === 'POST' && req.url === '/seeapi/v1/video/generations') {
      const body = JSON.parse(bodyText || '{}')
      lastVideoBody = body
      if (!body.aspect_ratio) {
        return send(400, { error: { code: 'validation_error', message: 'aspect_ratio is required.', type: 'invalid_request_error' } })
      }
      const id = String(body.prompt || '').includes('视频失败') ? 'up_fail' : 'up_ok'
      return send(200, { id, status: 'queued' })
    }
    if (req.method === 'GET' && req.url === '/seeapi/v1/tasks/up_ok') {
      videoPolls += 1
      if (videoPolls < 2) return send(200, { id: 'up_ok', status: 'running' })
      return send(200, { id: 'up_ok', status: 'succeeded', output: { video_url: base + '/files/clip.mp4' } })
    }
    if (req.method === 'GET' && req.url === '/seeapi/v1/tasks/up_fail') {
      return send(200, { id: 'up_fail', status: 'failed', error: { message: '上游合成失败' } })
    }
    if (req.method === 'GET' && req.url === '/files/clip.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(videoBytes.length) })
      res.end(videoBytes)
      return
    }
    send(404, { error: 'not found' })
  })
})
let base = ''
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + upstream.address().port
test.after(() => new Promise((resolve) => upstream.close(resolve)))

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const { createKey, reportKey } = await import('../server/keyvault.mjs')
const { config } = await import('../server/config.mjs')
const { createMediaGenRouter, resetMediaGenRateLimit } = await import('../server/routes/media-gen.mjs')

function email(name) {
  return name + String.fromCharCode(64) + 'media.test'
}

const owner = auth.createUser({ email: email('owner'), password: 'Passw0rd!demo', name: '生图用户', kind: 'user' })
const other = auth.createUser({ email: email('other'), password: 'Passw0rd!demo', name: '别人', kind: 'user' })
const failUser = auth.createUser({ email: email('fail'), password: 'Passw0rd!demo', name: '失败用户', kind: 'user' })
const videoUser = auth.createUser({ email: email('video'), password: 'Passw0rd!demo', name: '视频用户', kind: 'user' })
const videoFailUser = auth.createUser({ email: email('videofail'), password: 'Passw0rd!demo', name: '视频失败用户', kind: 'user' })
for (const user of [owner, other, failUser, videoUser, videoFailUser]) {
  if (credits.balanceOf(user.id) < 100) credits.grant(user.id, 100, { note: 'media-gen test' })
}

const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.10.1' }).token).split(';')[0]

const imageKey = createKey({
  name: '测试 GeteAPI 生图',
  provider: 'geteapi',
  baseUrl: base + '/v1',
  apiKey: 'sk-test-media-image-1234567890',
  models: ['gpt-image-2'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})
createKey({
  name: '测试 SeeAPI 生视频',
  provider: 'cgcm',
  baseUrl: base + '/seeapi',
  apiKey: 'sk-test-media-video-1234567890',
  models: ['seedance-2.0'],
  capabilities: ['video'],
  priority: 10,
  weight: 100,
})

function mockReq({ method = 'POST', body = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(Buffer.from(String(body)))
  req.push(null)
  return req
}

function mockRes() {
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.writableEnded = true
    },
  })
  Object.defineProperty(res, 'body', { get() { return Buffer.concat(this.chunks).toString('utf8') } })
  Object.defineProperty(res, 'raw', { get() { return Buffer.concat(this.chunks) } })
  return res
}

async function call({ method = 'POST', target = '/api/media/generate', body = null, cookie = '', headers = {} } = {}) {
  const router = createMediaGenRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  await router.handle(
    mockReq({ method, body: body === null ? null : JSON.stringify(body), cookie, headers }),
    res,
    url,
    url.pathname,
  )
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload, res, raw: res.raw }
}

test('新增价格默认 image_gen=5、video_gen=15，且会出现在积分汇总里', () => {
  if (!process.env.VQ_CREDIT_IMAGE_GEN) assert.equal(Number(config.credits.prices.image_gen), 5)
  if (!process.env.VQ_CREDIT_VIDEO_GEN) assert.equal(Number(config.credits.prices.video_gen), 15)
  const summary = credits.creditsFor(owner, { limit: 1 })
  assert.equal(typeof summary.prices.image_gen, 'number')
  assert.equal(typeof summary.prices.video_gen, 'number')
})

test('生图成功：扣 5 积分、结果落 data/media/<账号>/、只有自己能读', async () => {
  const before = credits.balanceOf(owner.id)
  const result = await call({ cookie: cookieOf(owner), body: { kind: 'image', prompt: '一只橘猫', ratio: '9:16' } })
  assert.equal(result.status, 200)
  assert.equal(result.payload.task.status, 'succeeded')
  assert.equal(result.payload.task.model, 'gpt-image-2')
  assert.equal(result.payload.task.size, '1024x1536')
  assert.equal(result.payload.task.credits.cost, 5)
  assert.equal(result.payload.task.credits.refunded, false)
  assert.equal(result.payload.task.file.mime, 'image/png')
  assert.equal(credits.balanceOf(owner.id), before - 5)

  const id = result.payload.task.id
  assert.equal(result.payload.task.downloadUrl, '/api/media/tasks/' + id + '/file')
  assert.ok(fs.existsSync(path.join(dir, 'media', owner.id, id + '.png')), '图片必须落在 data/media/<账号>/')

  const mine = await call({ method: 'GET', target: '/api/media/tasks/' + id, cookie: cookieOf(owner) })
  assert.equal(mine.status, 200)
  assert.equal(mine.payload.task.status, 'succeeded')

  const file = await call({ method: 'GET', target: '/api/media/tasks/' + id + '/file', cookie: cookieOf(owner) })
  assert.equal(file.status, 200)
  assert.equal(file.res.headers['Content-Type'], 'image/png')
  assert.deepEqual(file.raw, tinyPng)

  const stranger = await call({ method: 'GET', target: '/api/media/tasks/' + id, cookie: cookieOf(other) })
  assert.equal(stranger.status, 403)
  assert.equal(stranger.payload.code, 'MEDIA_TASK_FORBIDDEN')
  const strangerFile = await call({ method: 'GET', target: '/api/media/tasks/' + id + '/file', cookie: cookieOf(other) })
  assert.equal(strangerFile.status, 403)
  const anonymous = await call({ method: 'GET', target: '/api/media/tasks/' + id })
  assert.equal(anonymous.status, 401)
})

test('生图失败：返回失败任务、原因可见、积分全额退回，重复读不会多退', async () => {
  const before = credits.balanceOf(failUser.id)
  const result = await call({ cookie: cookieOf(failUser), body: { kind: 'image', prompt: '图失败', ratio: '1:1' } })
  assert.equal(result.status, 200)
  assert.equal(result.payload.task.status, 'failed')
  assert.match(result.payload.task.error, /上游/)
  assert.equal(result.payload.task.credits.refunded, true)
  assert.equal(credits.balanceOf(failUser.id), before, '失败必须全额退回')
  assert.equal(credits.outstandingCharge(failUser.id, 'image_gen', result.payload.task.id), 0)

  const again = await call({ method: 'GET', target: '/api/media/tasks/' + result.payload.task.id, cookie: cookieOf(failUser) })
  assert.equal(again.status, 200)
  assert.equal(credits.balanceOf(failUser.id), before, '重复读任务不能重复退款')
})

test('生视频：建任务后轮询，成功落 mp4、扣 15 积分；失败任务全额退', async () => {
  videoPolls = 0
  const before = credits.balanceOf(videoUser.id)
  const created = await call({ cookie: cookieOf(videoUser), body: { kind: 'video', prompt: '海边日落', duration: 4, resolution: '720p' } })
  assert.equal(created.status, 200)
  assert.equal(created.payload.task.status, 'processing')
  assert.equal(created.payload.task.credits.cost, 15)
  assert.equal(credits.balanceOf(videoUser.id), before - 15)
  assert.equal(lastVideoBody.aspect_ratio, '9:16', '界面没给比例控件，默认竖屏；缺这个字段上游直接 400')
  const id = created.payload.task.id

  const first = await call({ method: 'GET', target: '/api/media/tasks/' + id, cookie: cookieOf(videoUser) })
  assert.equal(first.status, 200)
  assert.equal(first.payload.task.status, 'processing')
  assert.equal(first.payload.warning, '')

  const done = await call({ method: 'GET', target: '/api/media/tasks/' + id, cookie: cookieOf(videoUser) })
  assert.equal(done.status, 200)
  assert.equal(done.payload.task.status, 'succeeded')
  assert.equal(done.payload.task.file.mime, 'video/mp4')
  assert.ok(fs.existsSync(path.join(dir, 'media', videoUser.id, id + '.mp4')))

  const file = await call({ method: 'GET', target: '/api/media/tasks/' + id + '/file', cookie: cookieOf(videoUser) })
  assert.equal(file.status, 200)
  assert.equal(file.res.headers['Content-Type'], 'video/mp4')
  assert.deepEqual(file.raw, videoBytes)

  const failBefore = credits.balanceOf(videoFailUser.id)
  const bad = await call({ cookie: cookieOf(videoFailUser), body: { kind: 'video', prompt: '视频失败', duration: 8, resolution: '480p' } })
  assert.equal(bad.status, 200)
  assert.equal(bad.payload.task.status, 'processing')
  const failed = await call({ method: 'GET', target: '/api/media/tasks/' + bad.payload.task.id, cookie: cookieOf(videoFailUser) })
  assert.equal(failed.status, 200)
  assert.equal(failed.payload.task.status, 'failed')
  assert.match(failed.payload.task.error, /上游合成失败/)
  assert.equal(failed.payload.task.credits.refunded, true)
  assert.equal(credits.balanceOf(videoFailUser.id), failBefore)
})

test('视频比例：显式给的 16:9 要透传给上游，给个不认识的比例 400 且不扣费', async () => {
  const user = auth.createUser({ email: email('ratio'), password: 'Passw0rd!demo', name: '比例用户', kind: 'user' })
  credits.grant(user.id, 100, { note: 'video ratio test' })
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)

  const bad = await call({ cookie, body: { kind: 'video', prompt: '海边日落', duration: 4, resolution: '480p', ratio: '4:3' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.code, 'MEDIA_RATIO')
  assert.equal(credits.balanceOf(user.id), before, '比例不认识不能扣积分')

  const ok = await call({ cookie, body: { kind: 'video', prompt: '海边日落', duration: 4, resolution: '480p', ratio: '16:9' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.payload))
  assert.equal(lastVideoBody.aspect_ratio, '16:9')
})

test('出图 Key 连续失败进冷却：说的是「等一会儿再点」，不是让人去补一把 Key', async () => {
  const user = auth.createUser({ email: email('cool'), password: 'Passw0rd!demo', name: '冷却用户', kind: 'user' })
  credits.grant(user.id, 100, { note: 'cooldown test' })
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)
  // 连续 3 次上游拒绝就把这把 Key 打进 60 秒冷却
  for (let round = 0; round < 3; round += 1) {
    const failed = await call({ cookie, body: { kind: 'image', prompt: '图失败', ratio: '1:1' } })
    assert.equal(failed.payload.task.status, 'failed')
  }
  const attemptsBefore = imageAttempts
  const cooled = await call({ cookie, body: { kind: 'image', prompt: '一只橘猫', ratio: '1:1' } })
  assert.equal(cooled.status, 200)
  assert.equal(cooled.payload.task.status, 'failed')
  // 关键：不许再叫人「补一把 Key」——Key 就在池里，只是刚被上游打了一下
  assert.match(cooled.payload.task.error, /冷却/)
  assert.match(cooled.payload.task.error, /再点一次/)
  assert.doesNotMatch(cooled.payload.task.error, /补一把|还没接入/)
  assert.equal(imageAttempts, attemptsBefore, '冷却期间不该再打上游，白花时间和额度')
  assert.equal(credits.balanceOf(user.id), before, '冷却失败要全额退回')
  reportKey(imageKey.id, true)
})

test('非法参数 400：缺提示词、坏比例、坏时长、坏分辨率、未知 kind 都不扣费', async () => {
  const before = credits.balanceOf(failUser.id)
  const cases = [
    { kind: 'image', prompt: '' },
    { kind: 'image', prompt: '猫', ratio: '4:3' },
    { kind: 'video', prompt: '海', duration: 5 },
    { kind: 'video', prompt: '海', resolution: '1080p' },
    { kind: 'audio', prompt: '海' },
  ]
  for (const body of cases) {
    const result = await call({ cookie: cookieOf(failUser), body })
    assert.equal(result.status, 400, JSON.stringify(body))
    assert.ok(result.payload.code)
  }
  assert.equal(credits.balanceOf(failUser.id), before, '参数校验失败不能扣积分')
})

test('按账号限流：同一账号一分钟内第 11 次生成请求 429', async () => {
  resetMediaGenRateLimit()
  const user = auth.createUser({ email: email('limited'), password: 'Passw0rd!demo', name: '限流用户', kind: 'user' })
  const cookie = cookieOf(user)
  for (let index = 0; index < 10; index += 1) {
    const result = await call({ cookie, body: { kind: 'image', prompt: '' } })
    assert.equal(result.status, 400)
  }
  const limited = await call({ cookie, body: { kind: 'image', prompt: '猫', ratio: '1:1' } })
  assert.equal(limited.status, 429)
  assert.equal(limited.payload.code, 'MEDIA_RATE_LIMITED')
  assert.ok(limited.payload.retryAfterSec >= 1)
})

test('未登录不能发起生成', async () => {
  const result = await call({ body: { kind: 'image', prompt: '猫' } })
  assert.equal(result.status, 401)
  assert.equal(result.payload.loginRequired, true)
})
test('最近生成：只列自己的、按时间倒序、按 kind 分开、未登录不给看', async () => {
  resetMediaGenRateLimit()
  const user = auth.createUser({ email: email('recent'), password: 'Passw0rd!demo', name: '最近生成用户', kind: 'user' })
  credits.grant(user.id, 100, { note: 'media recent test' })
  const cookie = cookieOf(user)

  const empty = await call({ method: 'GET', target: '/api/media/tasks', cookie })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.payload.tasks, [], '没生成过就给空清单，不是报错')

  const first = await call({ cookie, body: { kind: 'image', prompt: '第一张：橘猫', ratio: '1:1' } })
  assert.equal(first.status, 200)
  const second = await call({ cookie, body: { kind: 'video', prompt: '第二段：海边', ratio: '16:9', duration: 4, resolution: '720p' } })
  assert.equal(second.status, 200)
  assert.equal(second.payload.task.status, 'processing')

  const all = await call({ method: 'GET', target: '/api/media/tasks', cookie })
  assert.equal(all.status, 200)
  assert.deepEqual(
    all.payload.tasks.map((item) => item.id),
    [second.payload.task.id, first.payload.task.id],
    '新的一条排最前；还在跑的那条也要在清单里',
  )
  assert.equal(all.payload.tasks[0].status, 'processing')
  assert.equal(all.payload.tasks[1].status, 'succeeded')
  assert.ok(all.payload.tasks[1].downloadUrl, '成功的那条要能直接下载')

  const onlyImages = await call({ method: 'GET', target: '/api/media/tasks?kind=image', cookie })
  assert.equal(onlyImages.payload.kind, 'image')
  assert.deepEqual(onlyImages.payload.tasks.map((item) => item.id), [first.payload.task.id])

  const mine = [first.payload.task.id, second.payload.task.id]
  const stranger = await call({ method: 'GET', target: '/api/media/tasks', cookie: cookieOf(other) })
  assert.equal(stranger.status, 200)
  assert.ok(!stranger.payload.tasks.some((item) => mine.includes(item.id)), '别人的清单里不能出现我的任务')

  const anonymous = await call({ method: 'GET', target: '/api/media/tasks' })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.payload.loginRequired, true)

  const badKind = await call({ method: 'GET', target: '/api/media/tasks?kind=audio', cookie })
  assert.equal(badKind.status, 400)
  assert.equal(badKind.payload.code, 'MEDIA_KIND')

  const clamped = await call({ method: 'GET', target: '/api/media/tasks?limit=999', cookie })
  assert.ok(clamped.payload.tasks.length <= 24, 'limit 有上限，不能一次把目录翻完')
})

test('最近生成：失败那一条要带着原因回来，光说「失败」等于没说', async () => {
  resetMediaGenRateLimit()
  const user = auth.createUser({ email: email('recentfail'), password: 'Passw0rd!demo', name: '最近生成失败用户', kind: 'user' })
  credits.grant(user.id, 100, { note: 'media recent fail test' })
  const cookie = cookieOf(user)

  const created = await call({ cookie, body: { kind: 'image', prompt: '图失败：让上游拒绝这一次', ratio: '1:1' } })
  assert.equal(created.status, 200)
  assert.equal(created.payload.task.status, 'failed')

  const list = await call({ method: 'GET', target: '/api/media/tasks?kind=image', cookie })
  assert.equal(list.status, 200)
  const row = list.payload.tasks[0]
  assert.equal(row.id, created.payload.task.id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /上游/, '失败原因要跟着清单一起回来，界面上才有话可写')
  assert.equal(row.credits.refunded, true)
  assert.equal(row.downloadUrl, '', '失败的那条没有文件可下载，别给一个点了 404 的链接')
})
