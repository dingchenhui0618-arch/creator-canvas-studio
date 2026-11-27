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
// 参考图走的是 multipart 的 /images/edits：这里留住原始正文，断言字段与文件都真的发出去了
let lastEditBody = ''
// 参考素材上传（SeeAPI 的 /v1/assets/references/upload）：记下每次传的是什么类型
const refUploads = []
// 记一次真实打上游的次数：冷却中应当一次都不打，光看错误文案证明不了这一点。
let imageAttempts = 0
// r293：用户写死的尺寸要原样发给上游，所以要把生图请求正文留住
let lastImageBody = null
// 「永不回包」的上游连接：测试收尾要主动毁掉，否则 server.close() 会一直等着它
const held = []
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      // 按 utf8 解：正文里除了文件字节还有中文字段，断言时要能直接对上提示词
      lastEditBody = Buffer.concat(chunks).toString('utf8')
      return send(200, { created: 1, data: [{ b64_json: 'data:image/png;base64,' + tinyPng.toString('base64') }] })
    }
    if (req.method === 'POST' && req.url === '/seeapi/v1/assets/references/upload') {
      const text = Buffer.concat(chunks).toString('latin1')
      const kind = (text.match(/name="kind"\r\n\r\n(image|video)/) || [])[1] || ''
      const file = (text.match(/filename="([^"]+)"/) || [])[1] || ''
      refUploads.push({ kind, file, bytes: Buffer.concat(chunks).length })
      return send(200, { asset_uri: 'asset://' + kind })
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      imageAttempts += 1
      const body = JSON.parse(bodyText || '{}')
      lastImageBody = body
      const prompt = String(body.prompt || '')
      // 永不回包：专门测「我们等不住、把请求掐断」那条路，掐断后不能再被说成「连不上上游」
      if (prompt.includes('图超时')) {
        held.push(res)
        return
      }
      // 慢上游：证明请求不再挂在 HTTP 上，POST 应当立刻回任务号
      if (prompt.includes('慢')) {
        setTimeout(() => send(200, { created: 1, data: [{ b64_json: 'data:image/png;base64,' + tinyPng.toString('base64') }] }), 900)
        return
      }
      if (prompt.includes('图失败')) {
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
test.after(() => {
  for (const res of held) res.destroy()
  return new Promise((resolve) => upstream.close(resolve))
})

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
  models: ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})
createKey({
  name: '测试 SeeAPI 生视频',
  provider: 'cgcm',
  baseUrl: base + '/seeapi',
  apiKey: 'sk-test-media-video-1234567890',
  models: ['seedance-2.0', 'seedance-2.0-fast'],
  capabilities: ['video'],
  priority: 10,
  weight: 100,
})

function mockReq({ method = 'POST', body = null, raw = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (raw !== null) req.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
  else if (body !== null) req.push(Buffer.from(String(body)))
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

async function call({ method = 'POST', target = '/api/media/generate', body = null, raw = null, cookie = '', headers = {} } = {}) {
  const router = createMediaGenRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  await router.handle(
    mockReq({ method, body: body === null ? null : JSON.stringify(body), raw, cookie, headers }),
    res,
    url,
    url.pathname,
  )
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload, res, raw: res.raw }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 出图改成了后台任务：POST 只回一条 processing，结果要靠轮询拿。
// 假上游是本地即时响应，所以几十毫秒就能收敛；上限给 4 秒，超了就是真有问题。
async function waitTask(id, cookie, { tries = 120, gap = 40 } = {}) {
  for (let index = 0; index < tries; index += 1) {
    const result = await call({ method: 'GET', target: '/api/media/tasks/' + id, cookie })
    if (result.status !== 200) return result
    if (result.payload.task.status !== 'processing') return result
    await sleep(gap)
  }
  throw new Error('任务一直是 processing，后台没有收敛：' + id)
}

test('新增价格默认 image_gen=5、video_gen=15，且会出现在积分汇总里', () => {
  if (!process.env.VQ_CREDIT_IMAGE_GEN) assert.equal(Number(config.credits.prices.image_gen), 5)
  if (!process.env.VQ_CREDIT_VIDEO_GEN) assert.equal(Number(config.credits.prices.video_gen), 15)
  const summary = credits.creditsFor(owner, { limit: 1 })
  assert.equal(typeof summary.prices.image_gen, 'number')
  assert.equal(typeof summary.prices.video_gen, 'number')
})

test('生图成功：先回任务号、后台跑完再落盘，扣 3 积分（最便宜的 2.6）、只有自己能读', async () => {
  const before = credits.balanceOf(owner.id)
  const result = await call({ cookie: cookieOf(owner), body: { kind: 'image', prompt: '一只橘猫', ratio: '9:16' } })
  assert.equal(result.status, 200)
  assert.equal(result.payload.task.status, 'processing', 'POST 不再挂着等上游，先回一条 processing')
  assert.equal(result.payload.task.model, 'visionqa-image')
  assert.equal(result.payload.task.modelLabel, 'VisionQA通用图片模型')
  assert.equal(result.payload.task.size, '1024x1536')
  assert.equal(result.payload.task.credits.cost, 3)
  assert.equal(credits.balanceOf(owner.id), before - 3)

  const id = result.payload.task.id
  const settled = await waitTask(id, cookieOf(owner))
  assert.equal(settled.payload.task.status, 'succeeded')
  assert.equal(settled.payload.task.credits.refunded, false)
  assert.equal(settled.payload.task.file.mime, 'image/png')
  assert.equal(settled.payload.task.downloadUrl, '/api/media/tasks/' + id + '/file')
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

test('生图失败：失败原因可见、积分全额退回，重复读不会多退', async () => {
  const before = credits.balanceOf(failUser.id)
  const result = await call({ cookie: cookieOf(failUser), body: { kind: 'image', prompt: '图失败', ratio: '1:1' } })
  assert.equal(result.status, 200)
  const settled = await waitTask(result.payload.task.id, cookieOf(failUser))
  assert.equal(settled.payload.task.status, 'failed')
  assert.match(settled.payload.task.error, /上游/)
  assert.equal(settled.payload.task.credits.refunded, true)
  assert.equal(credits.balanceOf(failUser.id), before, '失败必须全额退回')
  assert.equal(credits.outstandingCharge(failUser.id, 'image_gen', settled.payload.task.id), 0)

  const again = await call({ method: 'GET', target: '/api/media/tasks/' + settled.payload.task.id, cookie: cookieOf(failUser) })
  assert.equal(again.status, 200)
  assert.equal(credits.balanceOf(failUser.id), before, '重复读任务不能重复退款')
})

test('生视频：建任务后轮询，成功落 mp4、扣 28 积分（4 秒 720p 按上游成本）；失败任务全额退', async () => {
  videoPolls = 0
  const before = credits.balanceOf(videoUser.id)
  const created = await call({ cookie: cookieOf(videoUser), body: { kind: 'video', prompt: '海边日落', duration: 4, resolution: '720p' } })
  assert.equal(created.status, 200)
  assert.equal(created.payload.task.status, 'processing')
  assert.equal(created.payload.task.credits.cost, 28)
  assert.equal(credits.balanceOf(videoUser.id), before - 28)
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
  // 连续 3 次上游拒绝就把这把 Key 打进 60 秒冷却。
  // 必须 try/finally 解除冷却：这条用例一旦中途失败（机器被占满时 waitTask 会超时），
  // 冷却状态会留给同一个文件后面所有出图用例，一个假失败滚成四五条（r217 实测）。
  try {
    for (let round = 0; round < 3; round += 1) {
      const queued = await call({ cookie, body: { kind: 'image', prompt: '图失败', ratio: '1:1' } })
      const failed = await waitTask(queued.payload.task.id, cookie)
      assert.equal(failed.payload.task.status, 'failed')
    }
    const attemptsBefore = imageAttempts
    const cooled = await call({ cookie, body: { kind: 'image', prompt: '一只橘猫', ratio: '1:1' } })
    assert.equal(cooled.status, 200)
    const cooledDone = await waitTask(cooled.payload.task.id, cookie)
    assert.equal(cooledDone.payload.task.status, 'failed')
    // 关键：不许再叫人「补一把 Key」——Key 就在池里，只是刚被上游打了一下
    assert.match(cooledDone.payload.task.error, /冷却/)
    assert.match(cooledDone.payload.task.error, /再点一次/)
    assert.doesNotMatch(cooledDone.payload.task.error, /补一把|还没接入/)
    assert.equal(imageAttempts, attemptsBefore, '冷却期间不该再打上游，白花时间和额度')
    assert.equal(credits.balanceOf(user.id), before, '冷却失败要全额退回')
  } finally {
    reportKey(imageKey.id, true)
  }
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
  await waitTask(first.payload.task.id, cookie)
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
  const settled = await waitTask(created.payload.task.id, cookie)
  assert.equal(settled.payload.task.status, 'failed')

  const list = await call({ method: 'GET', target: '/api/media/tasks?kind=image', cookie })
  assert.equal(list.status, 200)
  const row = list.payload.tasks[0]
  assert.equal(row.id, created.payload.task.id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /上游/, '失败原因要跟着清单一起回来，界面上才有话可写')
  assert.equal(row.credits.refunded, true)
  assert.equal(row.downloadUrl, '', '失败的那条没有文件可下载，别给一个点了 404 的链接')
})

test('最近生成能往回翻：游标只给更早的、翻到底 hasMore=false、坏游标 400、翻不到别人的', async () => {
  resetMediaGenRateLimit()
  const user = auth.createUser({ email: email('recentpage'), password: 'Passw0rd!demo', name: '最近生成翻页用户', kind: 'user' })
  credits.grant(user.id, 200, { note: 'media recent paging test' })
  const cookie = cookieOf(user)

  // 一次建 8 条：不加间隔也照样翻得完，游标是按位置取的，不按时间比
  const created = []
  for (let i = 0; i < 8; i += 1) {
    const result = await call({ cookie, body: { kind: 'image', prompt: '第 ' + i + ' 张：橘猫', ratio: '1:1' } })
    assert.equal(result.status, 200)
    created.push(result.payload.task.id)
  }
  const newestFirst = created.slice().reverse()

  const first = await call({ method: 'GET', target: '/api/media/tasks?kind=image&limit=3', cookie })
  assert.equal(first.status, 200)
  assert.deepEqual(first.payload.tasks.map((item) => item.id), newestFirst.slice(0, 3), '第一页是最近 3 条')
  assert.equal(first.payload.hasMore, true)
  assert.equal(first.payload.capped, false, '这里一共 8 条，没碰到扫描上限')

  const second = await call({ method: 'GET', target: '/api/media/tasks?kind=image&limit=3&before=' + newestFirst[2], cookie })
  assert.deepEqual(second.payload.tasks.map((item) => item.id), newestFirst.slice(3, 6), '第二页接着更早的三条')
  assert.equal(second.payload.hasMore, true)

  const third = await call({ method: 'GET', target: '/api/media/tasks?kind=image&limit=3&before=' + newestFirst[5], cookie })
  assert.deepEqual(third.payload.tasks.map((item) => item.id), newestFirst.slice(6), '第三页剩两条')
  assert.equal(third.payload.hasMore, false, '翻到底就是没有更多，别给一个点了没反应的按钮')

  const all = [first, second, third].flatMap((page) => page.payload.tasks.map((item) => item.id))
  assert.deepEqual(all, newestFirst, '三页拼起来不重不漏')

  const strangerCursor = await call({ method: 'GET', target: '/api/media/tasks?kind=image&limit=3&before=' + first.payload.tasks[0].id, cookie: cookieOf(other) })
  assert.deepEqual(strangerCursor.payload.tasks, [], '拿别人的任务号当游标，翻不出任何东西')

  const badCursor = await call({ method: 'GET', target: '/api/media/tasks?kind=image&before=nope!', cookie })
  assert.equal(badCursor.status, 400)
  assert.equal(badCursor.payload.code, 'MEDIA_CURSOR')
})

test('出图不再挂在 HTTP 请求上：慢上游下 POST 也立刻回任务号，结果靠轮询取', async () => {
  resetMediaGenRateLimit()
  const user = auth.createUser({ email: email('async'), password: 'Passw0rd!demo', name: '异步出图用户', kind: 'user' })
  credits.grant(user.id, 100, { note: 'async image test' })
  const cookie = cookieOf(user)

  const started = Date.now()
  const queued = await call({ cookie, body: { kind: 'image', prompt: '慢图：上游要 900 毫秒才回', ratio: '1:1' } })
  const elapsed = Date.now() - started
  assert.equal(queued.status, 200)
  assert.equal(queued.payload.task.status, 'processing')
  // 假上游固定慢 900ms：POST 要是还挂着等上游，这里就必然超 900ms
  assert.ok(elapsed < 600, 'POST 不能等上游生成，实际用了 ' + elapsed + ' ms')

  const done = await waitTask(queued.payload.task.id, cookie, { tries: 200, gap: 50 })
  assert.equal(done.payload.task.status, 'succeeded')
  assert.ok(done.payload.task.file, '后台跑完也要把文件落下来')
})

test('上游超时：说的是「N 秒没回、已退回」，不许说成「连不上上游」，也不许换 Key 再打一次', async () => {
  resetMediaGenRateLimit()
  const user = auth.createUser({ email: email('slow'), password: 'Passw0rd!demo', name: '超时用户', kind: 'user' })
  credits.grant(user.id, 100, { note: 'timeout test' })
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)
  const original = config.gateway.imageTimeoutMs
  // 这条测的是超时话术，不是响应速度。整套测试并发跑时机器被占满，POST 从建任务到写回响应
  // 中间还排着别的活；窗口给太小时，任务会先超时、响应里就已经是 failed，误报成「POST 直接回 failed」。
  // 生产的上游超时是 240 秒，这里给 3 秒仍然远小于它，断言（话术 / 全额退 / 不换 Key 重打）一条没放松。
  config.gateway.imageTimeoutMs = 3000
  try {
    const attemptsBefore = imageAttempts
    const queued = await call({ cookie, body: { kind: 'image', prompt: '图超时：上游一直不回包', ratio: '1:1' } })
    assert.equal(queued.status, 200)
    assert.equal(queued.payload.task.status, 'processing')

    const done = await waitTask(queued.payload.task.id, cookie, { tries: 160, gap: 50 })
    assert.equal(done.payload.task.status, 'failed')
    assert.match(done.payload.task.error, /秒没回/)
    assert.doesNotMatch(done.payload.task.error, /连不上/, '超时不是连不上，别把人往网络问题上带')
    assert.equal(done.payload.task.credits.refunded, true)
    assert.equal(credits.balanceOf(user.id), before, '超时也要全额退回')
    assert.equal(imageAttempts, attemptsBefore + 1, '超时后不许换 Key 重打：上游可能已经接单，重打就是重复扣费')
  } finally {
    config.gateway.imageTimeoutMs = original
    reportKey(imageKey.id, true)
  }
})

// ---------- 参考素材 + 模型选择（2026-11-18，对照晨羽智云原型补进快捷创作） ----------

function newUser(name) {
  const user = auth.createUser({ email: email(name), password: 'Passw0rd!demo', name, kind: 'user' })
  credits.grant(user.id, 100, { note: 'media refs test' })
  return user
}

test('模型清单：图片一组、视频一组，未真调的照实标出来，不给前端瞎猜的空间', async () => {
  const user = newUser('models')
  const result = await call({ method: 'GET', target: '/api/media/models', cookie: cookieOf(user) })
  assert.equal(result.status, 200)
  const models = result.payload
  // r298：界面只露一个显示模型，底下几条通道自动兜底，价钱按上游成本算
  assert.deepEqual(models.image.map((item) => item.id), ['visionqa-image'])
  assert.deepEqual(models.video.map((item) => item.id), ['visionqa-video'])
  assert.equal(models.defaults.image, 'visionqa-image')
  assert.equal(models.defaults.video, 'visionqa-video')
  const imageModel = models.image[0]
  assert.equal(imageModel.label, 'VisionQA通用图片模型')
  assert.equal(imageModel.channelCount, 3, '图片底下三条通道（2.6 / 2.5 / 2）')
  assert.equal(imageModel.credits, 3, '2.6 一张 $0.028 ≈ ¥0.20，加价 10% 取整 = 3 积分')
  const videoModel = models.video[0]
  assert.equal(videoModel.label, 'VisionQA通用视频模型')
  assert.equal(videoModel.verified, false, '默认走 fast，fast 没真调过，不能标已验')
  assert.equal(videoModel.referenceVerified, false, '参考生视频这轮没真调过，必须照实说')
  assert.equal(videoModel.channelCount, 2, '视频底下两条通道（fast / seedance-2.0）')
  assert.deepEqual(videoModel.durations, [4, 8])
  assert.deepEqual(videoModel.resolutions, ['720p', '480p'], '默认 720p：顺序就是界面默认值')
  assert.deepEqual(videoModel.priceTable, { '4|720p': 28, '4|480p': 13, '8|720p': 55, '8|480p': 26 })
  const reference = models.image[0].modes.find((item) => item.id === 'reference')
  assert.equal(reference.imageRefs, 1)
  const mixed = videoModel.modes.find((item) => item.id === 'mixed')
  assert.equal(mixed.imageRefs, 9)
  assert.equal(mixed.videoRefs, 3)
  const anonymous = await call({ method: 'GET', target: '/api/media/models' })
  assert.equal(anonymous.status, 401)
})

test('参考图：上传素材 → 参考图出图真的走 /images/edits，素材信息随任务回传', async () => {
  resetMediaGenRateLimit()
  const user = newUser('refimage')
  const cookie = cookieOf(user)
  const upload = await call({
    cookie,
    target: '/api/media/assets?name=' + encodeURIComponent('参考猫.png') + '&width=1024&height=1536',
    raw: tinyPng,
  })
  assert.equal(upload.status, 200, JSON.stringify(upload.payload))
  const asset = upload.payload.asset
  assert.equal(asset.kind, 'image')
  assert.equal(asset.bytes, tinyPng.length)
  assert.equal(asset.width, 1024)
  assert.equal(asset.height, 1536)
  assert.equal(asset.name, '参考猫.png')
  assert.equal(asset.previewUrl, '/api/media/assets/' + asset.id + '/file')

  // 预览：登录后能拿回原字节
  const preview = await call({ method: 'GET', target: asset.previewUrl, cookie })
  assert.equal(preview.status, 200)
  assert.deepEqual(preview.raw, tinyPng)

  const before = credits.balanceOf(user.id)
  const gen = await call({
    cookie,
    body: { kind: 'image', model: 'gpt-image-2', mode: 'reference', prompt: '照着参考图重画一张', ratio: '9:16', assets: [asset.id] },
  })
  assert.equal(gen.status, 200, JSON.stringify(gen.payload))
  assert.equal(gen.payload.task.mode, 'reference')
  assert.equal(gen.payload.task.assets.length, 1)
  assert.equal(gen.payload.task.assets[0].kind, 'image')
  assert.equal(credits.balanceOf(user.id), before - 3, '参考图出图也是 3 积分：走的是最便宜的 2.6')

  const settled = await waitTask(gen.payload.task.id, cookie)
  assert.equal(settled.payload.task.status, 'succeeded', settled.payload.task.error)
  assert.equal(settled.payload.task.credits.refunded, false)
  // 上游收到的必须是 multipart 的 edits：模型、提示词、尺寸、文件一个都不能少
  assert.match(lastEditBody, /name="model"\r\n\r\ngpt-image-2\.6/)
  assert.match(lastEditBody, /name="size"\r\n\r\n1024x1536/)
  assert.match(lastEditBody, /name="prompt"\r\n\r\n照着参考图重画一张/)
  assert.match(lastEditBody, /name="image"; filename="reference\.png"/)
})

test('参考视频 + 参考图：先换成 asset:// 再放进 reference_*_urls，模式按见 API 的规矩给', async () => {
  resetMediaGenRateLimit()
  refUploads.length = 0
  const user = newUser('refvideo')
  const cookie = cookieOf(user)
  const image = await call({ cookie, target: '/api/media/assets?name=' + encodeURIComponent('首帧.png'), raw: tinyPng })
  const video = await call({
    cookie,
    target: '/api/media/assets?name=' + encodeURIComponent('运镜.mp4') + '&duration=6&width=1280&height=720',
    raw: videoBytes,
  })
  assert.equal(image.status, 200, JSON.stringify(image.payload))
  assert.equal(video.status, 200, JSON.stringify(video.payload))
  assert.equal(video.payload.asset.kind, 'video')
  assert.equal(video.payload.asset.duration, 6)
  assert.equal(video.payload.asset.width, 1280)

  const gen = await call({
    cookie,
    body: {
      kind: 'video',
      model: 'seedance-2.0',
      mode: 'mixed',
      prompt: '按这两段参考生成一段镜头',
      duration: 4,
      resolution: '720p',
      ratio: '16:9',
      assets: [image.payload.asset.id, video.payload.asset.id],
    },
  })
  assert.equal(gen.status, 200, JSON.stringify(gen.payload))
  assert.equal(gen.payload.task.assets.length, 2)
  assert.equal(gen.payload.task.assets[1].duration, 6, '参考视频的时长要跟着任务走，界面上才说得清拿什么参考')
  assert.equal(lastVideoBody.aspect_ratio, '16:9')
  assert.equal(lastVideoBody.mode, 'mixed2video', '图和视频混着参考是 mixed2video')
  assert.deepEqual(lastVideoBody.reference_image_urls, ['asset://image'])
  assert.deepEqual(lastVideoBody.reference_video_urls, ['asset://video'])
  assert.equal(refUploads.length, 2)
  assert.deepEqual(refUploads.map((item) => item.kind), ['image', 'video'])
  assert.match(refUploads[0].file, /^reference_image_1\.png$/)
  assert.match(refUploads[1].file, /^reference_video_2\.mp4$/)
})

test('参考素材的规矩：文生模式不收素材、参考必须带图、别人的素材用不了、模型写错 400', async () => {
  resetMediaGenRateLimit()
  const user = newUser('refrules')
  const stranger = newUser('refstranger')
  const cookie = cookieOf(user)
  const mine = await call({ cookie, target: '/api/media/assets?name=我的图.png', raw: tinyPng })
  const theirs = await call({ cookie: cookieOf(stranger), target: '/api/media/assets?name=别人的图.png', raw: tinyPng })
  const before = credits.balanceOf(user.id)

  const unexpected = await call({ cookie, body: { kind: 'video', mode: 'text', prompt: '不要素材', assets: [mine.payload.asset.id] } })
  assert.equal(unexpected.status, 400)
  assert.equal(unexpected.payload.code, 'MEDIA_ASSETS_UNEXPECTED')

  const missing = await call({ cookie, body: { kind: 'image', mode: 'reference', prompt: '少了参考图', assets: [] } })
  assert.equal(missing.status, 400)
  assert.equal(missing.payload.code, 'MEDIA_ASSETS_REQUIRED')

  const foreign = await call({ cookie, body: { kind: 'image', mode: 'reference', prompt: '拿别人的图', assets: [theirs.payload.asset.id] } })
  assert.equal(foreign.status, 400)
  assert.equal(foreign.payload.code, 'MEDIA_ASSET_MISSING')

  const badModel = await call({ cookie, body: { kind: 'image', model: 'gpt-image-9', prompt: '模型写错' } })
  assert.equal(badModel.status, 400)
  assert.equal(badModel.payload.code, 'MEDIA_MODEL')

  const tooMany = await call({ cookie, body: { kind: 'image', mode: 'reference', prompt: '两张参考', assets: [mine.payload.asset.id, mine.payload.asset.id] } })
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.payload.code, 'MEDIA_ASSETS')

  assert.equal(credits.balanceOf(user.id), before, '参数不合规一律不扣积分')

  // 素材只属于上传的人：别人的 id 读不到、也下不了
  const strangerRead = await call({ method: 'GET', target: mine.payload.asset.previewUrl, cookie: cookieOf(stranger) })
  assert.equal(strangerRead.status, 404)
  const list = await call({ method: 'GET', target: '/api/media/assets', cookie })
  assert.equal(list.status, 200)
  assert.equal(list.payload.assets.length, 1)
  assert.equal(list.payload.assets[0].id, mine.payload.asset.id, '清单里只能有自己的素材')

  const removed = await call({ method: 'DELETE', target: '/api/media/assets/' + mine.payload.asset.id, cookie })
  assert.equal(removed.status, 200)
  const gone = await call({ method: 'GET', target: mine.payload.asset.previewUrl, cookie })
  assert.equal(gone.status, 404)
})

// ---------- 删掉一条生成记录（r282） ----------

test('删掉一条生成记录：记录与文件一起消失、清单里不再有它，但不退积分', async () => {
  resetMediaGenRateLimit()
  const user = newUser('delete')
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)
  const gen = await call({ cookie, body: { kind: 'image', prompt: '要删掉的一只猫', ratio: '1:1' } })
  const id = gen.payload.task.id
  const settled = await waitTask(id, cookie)
  assert.equal(settled.payload.task.status, 'succeeded')
  const filePath = path.join(dir, 'media', user.id, id + '.png')
  assert.ok(fs.existsSync(filePath))

  const listed = await call({ method: 'GET', target: '/api/media/tasks?kind=image', cookie })
  assert.ok(listed.payload.tasks.some((task) => task.id === id))

  const removed = await call({ method: 'DELETE', target: '/api/media/tasks/' + id, cookie })
  assert.equal(removed.status, 200, JSON.stringify(removed.payload))
  assert.equal(removed.payload.id, id)
  assert.equal(removed.payload.freedBytes, tinyPng.length, '释放的字节数要如实回')
  assert.equal(fs.existsSync(filePath), false, '结果文件必须一起删掉')
  assert.equal(fs.existsSync(path.join(dir, 'media', 'tasks', id + '.json')), false, '元数据也要删')

  const gone = await call({ method: 'GET', target: '/api/media/tasks/' + id, cookie })
  assert.equal(gone.status, 404)
  assert.equal(gone.payload.code, 'MEDIA_TASK_NOT_FOUND')

  const again = await call({ method: 'DELETE', target: '/api/media/tasks/' + id, cookie })
  assert.equal(again.status, 404, '删过的再删是 404，不是 200')

  const after = await call({ method: 'GET', target: '/api/media/tasks?kind=image', cookie })
  assert.equal(after.payload.tasks.some((task) => task.id === id), false)

  assert.equal(credits.balanceOf(user.id), before - 3, '删除不是退款：那次生成花的积分还在')
})

test('删别人的、没登录的、删下载地址、删还在跑的：四种都拒，且一个文件都不动', async () => {
  resetMediaGenRateLimit()
  const user = newUser('delmine')
  const stranger = newUser('delstranger')
  const cookie = cookieOf(user)
  const gen = await call({ cookie, body: { kind: 'image', prompt: '别人的图', ratio: '1:1' } })
  const id = gen.payload.task.id
  await waitTask(id, cookie)
  const filePath = path.join(dir, 'media', user.id, id + '.png')

  const foreign = await call({ method: 'DELETE', target: '/api/media/tasks/' + id, cookie: cookieOf(stranger) })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.payload.code, 'MEDIA_TASK_FORBIDDEN')
  const anonymous = await call({ method: 'DELETE', target: '/api/media/tasks/' + id })
  assert.equal(anonymous.status, 401)
  const fileUrl = await call({ method: 'DELETE', target: '/api/media/tasks/' + id + '/file', cookie })
  assert.equal(fileUrl.status, 405, '下载地址不能单独删')
  assert.ok(fs.existsSync(filePath), '上面这几次都不能把文件删掉')

  // 还在跑的不让删：删了元数据就再也没人对得上这笔账
  const running = await call({ cookie, body: { kind: 'image', prompt: '慢一点再回', ratio: '1:1' } })
  const runningId = running.payload.task.id
  const refused = await call({ method: 'DELETE', target: '/api/media/tasks/' + runningId, cookie })
  assert.equal(refused.status, 409)
  assert.equal(refused.payload.code, 'MEDIA_TASK_RUNNING')
  const settled = await waitTask(runningId, cookie)
  assert.equal(settled.payload.task.status, 'succeeded')
  const ok = await call({ method: 'DELETE', target: '/api/media/tasks/' + runningId, cookie })
  assert.equal(ok.status, 200, '跑完之后就能删')
})

test('两个界面都接上了删除：最近生成与作品流浮层走同一个接口，还在跑的自己先锁住', () => {
  const agents = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'AgentsPage.tsx'), 'utf8')
  assert.match(agents, /deleteMediaTask\(item\.id\)/)
  assert.match(agents, /agx-media-recent-del/)
  assert.match(agents, /item\.status === 'processing' \|\| deletingId === item\.id/, '还在跑的那条按钮要锁住')
  const works = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'WorksWall.tsx'), 'utf8')
  assert.match(works, /deleteMediaTask\(taskId\)/)
  assert.match(works, /function canDelete/, '只有快捷创作的图与视频能删')
  const api = fs.readFileSync(path.join(process.cwd(), 'src', 'api', 'media-gen.ts'), 'utf8')
  assert.match(api, /deleteMediaTask = \(id: string\)/)
})


// ---------- r288：对话框里一句话直接生成 ----------
// 这一节验的是「同一套生成管线被对话框复用」：不经过文本模型、不扣对话那 1 积分，
// 只扣生成积分；任务、退款、落盘、最近生成全是原来的那套（所以这里只验接线与归属）。
const { sendChatMessage, streamChatMessage } = await import('../server/chat.mjs')
const { getConversation } = await import('../server/chat-store.mjs')

test('对话框里 /生图：不走文本模型、不扣对话费，直接建出图片任务并落到会话里', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatimg')
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)

  const result = await streamChatMessage(user, { content: '/生图 9:16 咖啡店门口的雨夜海报' }, {})
  assert.equal(result.cost, 0, '这一轮没走对话模型：对话那 1 积分不该扣')
  assert.equal(result.media.kind, 'image')
  assert.equal(result.media.model, 'visionqa-image')
  assert.equal(result.media.ratio, '9:16')
  assert.equal(result.media.size, '1024x1536')
  assert.equal(result.media.credits.cost, 3)
  assert.equal(result.balance, before - 3, '只扣生成的 3 积分')
  assert.equal(credits.balanceOf(user.id), before - 3)
  assert.match(result.reply.content, /已开始生成图片/)
  assert.match(result.reply.content, /VisionQA通用图片模型 · 9:16 · 1024x1536/)
  assert.match(result.reply.content, /最近生成/)

  // 会话里要留得住这两条：关掉页面回来还能看到那张卡片（卡片按 meta.media.id 轮询）
  const stored = getConversation(user.id, result.conversation.id)
  assert.equal(stored.messages.length, 2)
  assert.equal(stored.messages[0].content, '/生图 9:16 咖啡店门口的雨夜海报')
  assert.equal(stored.messages[1].meta.media.id, result.media.id)
  assert.equal(stored.messages[1].meta.media.downloadUrl, '/api/media/tasks/' + result.media.id + '/file')

  const settled = await waitTask(result.media.id, cookie)
  assert.equal(settled.payload.task.status, 'succeeded')
  assert.ok(fs.existsSync(path.join(dir, 'media', user.id, result.media.id + '.png')))
})

test('对话框里 /生视频：比例、时长、清晰度按用户说的发给上游，扣 15 积分', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatvid')
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)
  videoPolls = 0

  const result = await sendChatMessage(user, { content: '/生视频 16:9 8秒 480p 海边日落' })
  assert.equal(result.cost, 0)
  assert.equal(result.media.kind, 'video')
  assert.equal(result.media.duration, 8)
  assert.equal(result.media.resolution, '480p')
  assert.equal(credits.balanceOf(user.id), before - 26, '8 秒 480p：¥0.28614 × 8 × 1.1 × 10 = 26 积分')
  assert.equal(lastVideoBody.aspect_ratio, '16:9', '对话框里的比例也必须真的发给上游')
  assert.equal(Number(lastVideoBody.duration), 8)
  assert.equal(String(lastVideoBody.resolution), '480p')
  assert.match(result.reply.content, /视频要几分钟/)

  const first = await call({ method: 'GET', target: '/api/media/tasks/' + result.media.id, cookie })
  assert.equal(first.status, 200)
  const done = await call({ method: 'GET', target: '/api/media/tasks/' + result.media.id, cookie })
  assert.equal(done.payload.task.status, 'succeeded')
})

test('对话框生成失败：任务标失败、积分全额退回，会话里那句话还在', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatfail')
  const cookie = cookieOf(user)
  const before = credits.balanceOf(user.id)

  const result = await sendChatMessage(user, { content: '/生图 图失败 一只橘猫' })
  assert.equal(result.media.status, 'processing')
  const settled = await waitTask(result.media.id, cookie)
  assert.equal(settled.payload.task.status, 'failed')
  assert.equal(settled.payload.task.credits.refunded, true)
  assert.equal(credits.balanceOf(user.id), before, '失败必须全额退回')
  const stored = getConversation(user.id, result.conversation.id)
  assert.equal(stored.messages.length, 2, '失败也要留下「我让他画了什么」')
})

test('积分不够：一个字节都不发给上游，说清楚要多少、还差多少', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatpoor')
  credits.charge(user.id, 'chat', { ref: '清空余额', amount: credits.balanceOf(user.id) })
  const attempts = imageAttempts
  await assert.rejects(() => sendChatMessage(user, { content: '/生图 一只橘猫' }), (error) => {
    assert.equal(error.status, 402)
    assert.match(error.message, /积分不足/)
    return true
  })
  assert.equal(imageAttempts, attempts, '余额不够就不该打上游')
})

// r289：对话里带一张图就能「按这张重画 / 拿这张当首帧」——不再拦着让人先去「图片」页签入素材库。
// 图不进素材库：字节只在内存里传给生成管线，任务元数据里只留参考素材的形状（卡片据此写「参考 1 张」）。
test('对话框里带一张参考图 /生图：真的走参考图出图，只扣 5 积分，附件留在会话里', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatrep')
  const cookie = cookieOf(user)
  const { saveChatFile } = await import('../server/chat-files.mjs')
  const file = saveChatFile({ userId: user.id, buffer: tinyPng, name: '参考.png' })
  const before = credits.balanceOf(user.id)
  lastEditBody = ''

  const result = await sendChatMessage(user, { content: '/生图 照这张画成海报', files: [file.id] })
  assert.equal(result.cost, 0, '带图的生成也不扣对话那 1 积分')
  assert.equal(result.media.status, 'processing')
  assert.equal(result.media.kind, 'image')
  assert.equal(result.media.mode, 'reference', '带图就必须是 reference，而不是文生图')
  assert.equal(result.media.assets.length, 1)
  assert.equal(result.media.assets[0].name, '参考.png')
  assert.match(result.reply.content, /参考 1 张/, '回话里要写清用了参考图')
  assert.equal(credits.balanceOf(user.id), before - 3)

  // 上游收到的必须是 multipart 的 edits，文件真的是我们那张
  await waitTask(result.media.id, cookie)
  assert.match(lastEditBody, /照这张画成海报/)
  assert.match(lastEditBody, /filename="reference\.png"/)
  assert.ok(fs.existsSync(path.join(dir, 'media', user.id, result.media.id + '.png')))

  const stored = getConversation(user.id, result.conversation.id)
  assert.equal(stored.messages[0].files.length, 1, '那条消息上要能点开自己传的图')
  assert.equal(stored.messages[1].meta.media.assets.length, 1)
})

test('对话框里带一张图 /生视频：拿它当首帧，上游收到 image2video 与参考素材', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatvidref')
  const { saveChatFile } = await import('../server/chat-files.mjs')
  const file = saveChatFile({ userId: user.id, buffer: tinyPng, name: '首帧.png' })
  const before = credits.balanceOf(user.id)
  videoPolls = 0
  refUploads.length = 0

  const result = await sendChatMessage(user, { content: '/生视频 16:9 4秒 480p 让这张动起来', files: [file.id] })
  assert.equal(result.media.kind, 'video')
  assert.equal(result.media.mode, 'first')
  assert.equal(result.media.assets.length, 1)
  assert.equal(credits.balanceOf(user.id), before - 13, '4 秒 480p：¥0.28614 × 4 × 1.1 × 10 = 13 积分')
  assert.equal(lastVideoBody.mode, 'image2video', '只带图就是图生视频')
  assert.equal(lastVideoBody.aspect_ratio, '16:9')
  assert.deepEqual(lastVideoBody.reference_image_urls, ['asset://image'])
  assert.equal(refUploads.length, 1)
  assert.equal(refUploads[0].kind, 'image')
})

// r342：以前这里直接报错拦下（「最多带 1 张参考图」）。生产上的真事是：用户带了 2 张商品图，
// 报错让他去删图，删完再发就丢了一次机会。现在按第 1 张当参考，并在回话里说清用的是哪一张——
// 不静默挑图，也不把用户挡在门外。
test('对话框里一次带两张图：按第 1 张当参考，回话里说清是哪一张', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatrefmany')
  const { saveChatFile } = await import('../server/chat-files.mjs')
  const one = saveChatFile({ userId: user.id, buffer: tinyPng, name: '一.png' })
  const two = saveChatFile({ userId: user.id, buffer: tinyPng, name: '二.png' })
  const before = credits.balanceOf(user.id)
  lastEditBody = ''

  const result = await sendChatMessage(user, { content: '/生图 照这张画', files: [one.id, two.id] })
  assert.equal(result.media.mode, 'reference')
  assert.equal(result.media.assets.length, 1)
  assert.equal(result.media.assets[0].name, '一.png', '按第 1 张当参考')
  assert.equal(credits.balanceOf(user.id), before - 3)
  assert.match(result.reply.content, /按第 1 张/, '要明说用的是哪一张，不静默挑图')
  await waitTask(result.media.id, cookieOf(user))
  assert.match(lastEditBody, /filename="reference\.png"/)
})

test('对话框里带文档下生成指令：说清文档没算进去，一分钱不扣', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatrefdoc')
  const { saveChatFile } = await import('../server/chat-files.mjs')
  const doc = saveChatFile({ userId: user.id, buffer: Buffer.from('第一场：咖啡店门口。', 'utf8'), name: '脚本.txt' })
  const before = credits.balanceOf(user.id)
  await assert.rejects(() => sendChatMessage(user, { content: '/生图 按脚本画一张', files: [doc.id] }), (error) => {
    assert.equal(error.code, 'MEDIA_CHAT_REF_DOC')
    assert.match(error.message, /脚本\.txt/)
    return true
  })
  assert.equal(credits.balanceOf(user.id), before)
})

test('只说「怎么生成图」：照旧走对话模型，不扣生成积分', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatask')
  const before = credits.balanceOf(user.id)
  // 这个测试文件没有配文本 Key：走到对话模型就会失败；重点是要证明它「没有」去生成
  await assert.rejects(() => sendChatMessage(user, { content: '怎么生成图？' }), (error) => {
    assert.equal(String(error.code || '').startsWith('MEDIA_'), false, '不该被当成生成指令')
    return true
  })
  assert.notEqual(credits.balanceOf(user.id), before - 5, '不该扣生成积分')
})

// r293：口语也直接出片，不必先教用户「要以 / 开头」
test('对话框里说「帮我出个视频，…」：口语也直接开任务，比例进上游', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatspoken')
  const before = credits.balanceOf(user.id)
  videoPolls = 0

  const result = await sendChatMessage(user, { content: '帮我出个视频，咖啡店门口的雨夜' })
  assert.equal(result.cost, 0)
  assert.equal(result.media.kind, 'video')
  assert.equal(result.media.duration, 4)
  assert.equal(credits.balanceOf(user.id), before - 28)
  assert.equal(lastVideoBody.aspect_ratio, '9:16')
})

// r293：写死的秒数 / 清晰度不再被默认档位顶掉，原样发给上游；上游不认就失败退款
test('对话框里写死 1080p 12 秒：原样发给上游，并在回话里说明是照写死提交的', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatlocked')
  // 12 秒 1080p 按上游成本算要 168 积分（¥15.26 × 1.1），余额得够才验得到「原样提交」
  credits.grant(user.id, 300, { note: 'chatlocked 1080p' })
  const before = credits.balanceOf(user.id)
  videoPolls = 0

  const result = await sendChatMessage(user, { content: '/生视频 1080p 12秒 海边日落' })
  assert.equal(Number(lastVideoBody.duration), 12, '12 秒必须原样交给上游')
  assert.equal(String(lastVideoBody.resolution), '1080p', '1080p 必须原样交给上游')
  assert.equal(credits.balanceOf(user.id), before - 168)
  assert.match(result.reply.content, /写死/)
  assert.match(result.reply.content, /1080p/)
})

test('对话框里写死 2048x2048：生图请求里就是 2048x2048，不是 1024x1024', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatimgsize')
  const before = credits.balanceOf(user.id)
  lastImageBody = null

  const result = await sendChatMessage(user, { content: '/生图 2048x2048 白底产品图' })
  assert.equal(result.media.size, '2048x2048')
  assert.equal(credits.balanceOf(user.id), before - 3)
  await waitTask(result.media.id, cookieOf(user))
  assert.equal(lastImageBody.size, '2048x2048', '尺寸必须真的发出去，不能只在元数据里写写')
})

// 只说了要视频、没说画面：本机没配文本通道就回一句人话，绝不拿空提示词去扣 15 积分
test('只写「帮我出个视频」且本机没有文本通道：不扣积分、不打上游，回一句补画面', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatnoprompt')
  const before = credits.balanceOf(user.id)
  const attempts = imageAttempts
  const beforeVideoBody = lastVideoBody

  await assert.rejects(
    () => sendChatMessage(user, { content: '帮我出个视频' }),
    (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /补一句画面|后面写清要拍什么/)
      return true
    },
  )
  assert.equal(credits.balanceOf(user.id), before, '没开任务就不能扣钱')
  assert.equal(imageAttempts, attempts)
  assert.equal(lastVideoBody, beforeVideoBody, '一个字都不该发给视频上游')
})

// ---------- r342：对话框里的参数跟用户选的走（2026-11-27 生产投诉） ----------

// 生产原句：「生成一张欧美女星带首饰的图 3：4的比例」。
// 改前：全角冒号不认，出图按 1:1，提示词还被存成「欧美女星带首饰的图 3 4的比例」。
test('生产原句 3：4：比例真的生效（1152x1536），而且不再留在提示词里', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatratio34')
  lastImageBody = null

  const result = await sendChatMessage(user, { content: '生成一张欧美女星带首饰的图 3：4的比例' })
  assert.equal(result.media.kind, 'image')
  assert.equal(result.media.ratio, '3:4')
  assert.equal(result.media.size, '1152x1536')
  assert.equal(result.media.prompt, '欧美女星带首饰', '参数不能留在提示词里')
  assert.match(result.reply.content, /3:4/)
  await waitTask(result.media.id, cookieOf(user))
  assert.equal(lastImageBody.size, '1152x1536', '尺寸必须真的发给上游')
  assert.ok(!String(lastImageBody.prompt).includes('比例'), '参数词不能跟着提示词发给上游')
})

test('对话框里选的比例 / 画质盖过提示词里写的那份，画质真的发到上游', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatpicked')
  lastImageBody = null

  const result = await sendChatMessage(user, {
    content: '/生图 1:1 白底产品图',
    media: { ratio: '9:16', quality: 'high' },
  })
  assert.equal(result.media.ratio, '9:16', '下拉里选的比例说了算')
  assert.equal(result.media.size, '1024x1536')
  assert.equal(result.media.quality, 'high')
  assert.equal(result.media.prompt, '白底产品图', '文本里那份比例要抠掉，即使被下拉盖过')
  await waitTask(result.media.id, cookieOf(user))
  assert.equal(lastImageBody.size, '1024x1536')
  assert.equal(lastImageBody.quality, 'high', '画质必须真的发出去，不能只在元数据里写写')
})

test('没在下拉里选画质：一个 quality 字段都不发给上游', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatnoquality')
  lastImageBody = null

  const result = await sendChatMessage(user, { content: '/生图 白底产品图' })
  assert.equal(result.media.quality, '')
  await waitTask(result.media.id, cookieOf(user))
  assert.equal(lastImageBody.quality, undefined, '没选就不传，别替上游决定默认档')
})

// 用户先传了商品图、下一句「生成一张…」没有附件：改前被当成纯文生图，用户看到的就是「参考图没被遵循」
test('参考图沿用：生成指令没带附件时，按这条对话里用户最近发的那张图重画', async () => {
  resetMediaGenRateLimit()
  const user = newUser('chatrefcarry')
  const cookie = cookieOf(user)
  const { saveChatFile } = await import('../server/chat-files.mjs')
  const { createConversation, saveConversation } = await import('../server/chat-store.mjs')
  const file = saveChatFile({ userId: user.id, buffer: tinyPng, name: '商品图.png' })
  const conv = createConversation(user.id, { title: '参考图沿用' })
  conv.messages.push({
    id: 'u-ref',
    role: 'user',
    content: '这是我的商品图',
    at: Date.now(),
    files: [{ id: file.id, name: '商品图.png', kind: 'image', mime: 'image/png', bytes: tinyPng.length }],
  })
  saveConversation(user.id, conv)
  lastEditBody = ''

  const result = await sendChatMessage(user, { content: '/生图 照这张画成商品主图', conversationId: conv.id })
  assert.equal(result.media.mode, 'reference', '没带附件也要沿用对话里那张图，不能退回文生图')
  assert.equal(result.media.assets.length, 1)
  assert.equal(result.media.assets[0].name, '商品图.png')
  assert.match(result.reply.content, /上一条带的那张图/, '要写明用的是哪张，别让用户以为它没被遵循')
  await waitTask(result.media.id, cookie)
  assert.match(lastEditBody, /filename="reference\.png"/)
  const stored = getConversation(user.id, conv.id)
  const genMessage = stored.messages[stored.messages.length - 2]
  assert.equal(genMessage.files, undefined, '沿用过来的那张不挂回这条消息')
})
