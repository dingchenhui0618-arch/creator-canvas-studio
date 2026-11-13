// 评审入口的两道前置闸（2026-11-14 压测后补）：
//   1) 本地素材必须是图，且 ≤ 8 MB —— 以前只校验路径，指到数据目录里的 160 MB 源视频就能把进程顶穿；
//   2) 被拒的这单不扣积分、不占并发名额、不落评审记录。
// 这两条都是「一次请求就能打死整个进程」的入口，所以要有路由级测试，不能只测纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-media-'))
process.env.VQ_KEY_SECRET = 'test-secret-review-media'
// 单测不许碰真实上游：把模型地址指向一个必定连不上的端口，第 4 条用例只用来看「前置闸放行」，
// 走到模型那一步报什么错都不影响结论。
process.env.VISION_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.VISION_API_KEY = 'test-key-not-real'

const { config } = await import('../server/config.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const gate = await import('../server/gate.mjs')
const { createReviewRouter } = await import('../server/routes/review.mjs')
const { refusalResponse } = await import('../server/public-error.mjs')

const me = auth.createUser({ email: '[EMAIL:RM1]', password: 'Passw0rd!demo', name: '评审用例' })
const cookie = auth.sessionCookie(auth.createSession(me, { userAgent: 'test', ip: '10.0.5.1' }).token).split(';')[0]
const balance = () => credits.balanceOf(me.id)

const mediaDir = path.join(config.dataDir, 'media')
fs.mkdirSync(mediaDir, { recursive: true })
fs.writeFileSync(path.join(mediaDir, 'ok.jpg'), Buffer.alloc(2048, 0x11))
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.alloc(4096, 0x22))
fs.writeFileSync(path.join(mediaDir, 'big.png'), Buffer.alloc(9 * 1024 * 1024, 0x33))

function mockReq({ method = 'POST', body = null, cookie: c = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = c ? { cookie: c } : {}
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

async function postReview(body) {
  const router = createReviewRouter()
  const res = mockRes()
  let thrown = null
  try {
    const target = '/api/review'
    await router.handle(mockReq({ cookie, body }), res, new URL('http://127.0.0.1' + target), target)
  } catch (error) {
    thrown = error
  }
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload, thrown }
}

test('素材是视频：415 拒掉，不扣积分、不占名额', async () => {
  const before = balance()
  const result = await postReview({ media: 'media/clip.mp4', intent: '不该开始的评审' })
  assert.equal(result.thrown?.status, 415)
  assert.equal(result.thrown?.code, 'MEDIA_TYPE')
  assert.match(result.thrown.message, /只接受 jpg \/ png \/ webp/)
  const mapped = refusalResponse(result.thrown)
  assert.equal(mapped.status, 415)
  assert.equal(mapped.body.code, 'MEDIA_TYPE')
  assert.equal(balance(), before, '被拒的评审不能扣积分')
  assert.equal(Object.keys(gate.snapshot()).length, 0, '被拒的评审不能占到并发名额')
})

test('图片超过 8 MB：413 拒掉，且根本没有读进内存', async () => {
  const before = balance()
  const result = await postReview({ media: 'media/big.png', intent: '太大' })
  assert.equal(result.thrown?.status, 413)
  assert.equal(result.thrown?.code, 'MEDIA_TOO_LARGE')
  assert.match(result.thrown.message, /8 MB/)
  assert.equal(refusalResponse(result.thrown).status, 413)
  assert.equal(balance(), before)
})

test('路径跳到数据目录外 / 图片不存在：400 / 404，都不扣积分', async () => {
  const before = balance()
  const outside = await postReview({ media: '../../etc/passwd' })
  assert.equal(outside.thrown?.status, 400)
  assert.equal(outside.thrown?.code, 'MEDIA_PATH')
  const missing = await postReview({ media: 'media/nope.jpg' })
  assert.equal(missing.thrown?.status, 404)
  assert.equal(missing.thrown?.code, 'MEDIA_MISSING')
  assert.equal(balance(), before)
  assert.equal(Object.keys(gate.snapshot()).length, 0)
})

test('合法的图不会被前置闸拒掉（会继续往下走到模型链路）', async () => {
  const result = await postReview({ media: 'media/ok.jpg', intent: '这张图应该能进到评审' })
  // 单测环境没有模型凭证：要么 503 MODEL_UNAVAILABLE/NO_MODEL 这类业务错，要么真的出了结论，
  // 但绝不能是 MEDIA_TYPE / MEDIA_TOO_LARGE 这两道前置闸。
  const code = result.thrown?.code || result.payload?.code || ''
  assert.ok(!['MEDIA_TYPE', 'MEDIA_TOO_LARGE', 'MEDIA_MISSING', 'MEDIA_PATH'].includes(code), '合法图片不该被素材闸拦下：' + code)
})
