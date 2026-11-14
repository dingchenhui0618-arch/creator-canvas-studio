// 传一张自己的图（v0.9.87）：这个入口一次能读进 8 MB 内容，所以「认不认图片」「收不收得下」
// 「别人能不能读」这三件事都要在路由层测，不能只测纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-upload-'))
process.env.VQ_KEY_SECRET = 'test-secret-upload'
process.env.VQ_REQUIRE_AUTH = '1'
// 单测不碰真实上游：评审那条路由会被顺带测到，地址指到必定连不上的端口
process.env.VISION_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.VISION_API_KEY = 'test-key-not-real'

const uploads = await import('../server/uploads.mjs')
const auth = await import('../server/auth.mjs')
const { createMediaRouter } = await import('../server/routes/media.mjs')
const { createReviewRouter } = await import('../server/routes/review.mjs')
const { readBinaryBody } = await import('../server/body-reader.mjs')
const { UPLOAD_LIMITS } = uploads

const MB = 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const WEBP_SIGNATURE = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP')])

function imageBuffer(signature, size = 512) {
  const buffer = Buffer.alloc(size, 0x20)
  signature.copy(buffer, 0)
  return buffer
}

const owner = auth.createUser({ email: 'upload-owner@example.invalid', password: 'Passw0rd!demo', name: '上传者' })
const other = auth.createUser({ email: 'upload-other@example.invalid', password: 'Passw0rd!demo', name: '别人' })
const admin = auth.createUser({ email: 'upload-admin@example.invalid', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.6.1' }).token).split(';')[0]

function mockReq({ method = 'POST', body = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body !== null) req.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
  req.push(null)
  return req
}

function mockRes() {
  return {
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
      this.chunks.push(Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.writableEnded = true
    },
    get body() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
  }
}

async function call({ method = 'POST', target = '/api/media/upload', body = null, cookie = '', headers = {} } = {}) {
  const router = createMediaRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  // 第四个参数是路由看到的 pathname（线上来自 decodeURIComponent(url.pathname)），查询串不算在里面
  await router.handle(mockReq({ method, body, cookie, headers }), res, url, url.pathname)
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload, res }
}

test('按文件头认图：png / jpg / webp 认，改名的 html 不认', () => {
  assert.equal(uploads.sniffImage(imageBuffer(PNG_SIGNATURE)).ext, 'png')
  assert.equal(uploads.sniffImage(imageBuffer(JPG_SIGNATURE)).ext, 'jpg')
  assert.equal(uploads.sniffImage(imageBuffer(WEBP_SIGNATURE)).ext, 'webp')
  assert.equal(uploads.sniffImage(Buffer.from('<html><body>hi</body></html>')), null)
  assert.equal(uploads.sniffImage(Buffer.alloc(0)), null)
  assert.equal(uploads.sniffImage(null), null)
})

test('落盘路径是服务端起的名字：uploads/<账号>/<时间戳>-<随机>.<ext>', async () => {
  const saved = await uploads.saveUpload({ userId: owner.id, buffer: imageBuffer(PNG_SIGNATURE) })
  assert.match(saved.media, new RegExp('^uploads/' + owner.id + '/\\d{10,16}-[0-9a-f]{12}\\.png$'))
  assert.equal(saved.imageUrl, '/media/' + saved.media)
  assert.equal(saved.mime, 'image/png')
  assert.equal(saved.usage.files, 1)
  assert.ok(fs.existsSync(path.join(uploads.uploadsRoot(), owner.id, saved.media.split('/').pop())))
})

test('不是图片 / 太大 / 空的：415 / 413 / 400，一个字节都不落盘', async () => {
  const html = await call({ cookie: cookieOf(owner), body: Buffer.from('<html>not an image</html>') })
  assert.equal(html.status, 415)
  assert.equal(html.payload.code, 'UPLOAD_TYPE')

  const empty = await call({ cookie: cookieOf(owner), body: Buffer.alloc(0) })
  assert.equal(empty.status, 400)
  assert.equal(empty.payload.code, 'UPLOAD_EMPTY')

  // content-length 就超了：在读到内容之前拒（body-reader 的三道闸里最便宜的那道）
  const tooBig = await call({ cookie: cookieOf(owner), body: imageBuffer(PNG_SIGNATURE, 64), headers: { 'content-length': String(9 * MB) } })
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.payload.code, 'BODY_TOO_LARGE')
})

test('读请求体：超过上限抛 413，且不把整包读进内存', async () => {
  await assert.rejects(
    () => readBinaryBody(mockReq({ body: imageBuffer(PNG_SIGNATURE, 4096), headers: { 'content-length': String(11 * MB) } }), { maxBytes: UPLOAD_LIMITS.maxBytes }),
    (error) => error.status === 413 && error.code === 'BODY_TOO_LARGE',
  )
})

test('没登录不能传：401，且目录里一张也没多', async () => {
  const before = await uploads.uploadUsage(owner.id)
  const result = await call({ body: imageBuffer(PNG_SIGNATURE) })
  assert.equal(result.status, 401)
  assert.equal(result.payload.loginRequired, true)
  const after = await uploads.uploadUsage(owner.id)
  assert.equal(after.files, before.files)
})

test('传成功回 media 与占用；只给传的人看，别人 404、管理员能看', async () => {
  const uploaded = await call({ cookie: cookieOf(owner), body: imageBuffer(PNG_SIGNATURE, 2048) })
  assert.equal(uploaded.status, 200)
  assert.equal(uploaded.payload.ok, true)
  assert.equal(uploaded.payload.usage.maxFiles, UPLOAD_LIMITS.maxFiles)
  const media = uploaded.payload.media
  const url = '/media/' + media

  const mine = await call({ method: 'GET', target: url, cookie: cookieOf(owner) })
  assert.equal(mine.status, 200)
  assert.equal(mine.res.headers['Content-Type'], 'image/png')
  assert.equal(mine.res.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(mine.res.chunks[0].length, 2048)

  const stranger = await call({ method: 'GET', target: url, cookie: cookieOf(other) })
  assert.equal(stranger.status, 404, '别人的图不该被读到，连存在性也不告诉')

  const bossRead = await call({ method: 'GET', target: url, cookie: cookieOf(admin) })
  assert.equal(bossRead.status, 200)

  const anonymous = await call({ method: 'GET', target: url })
  assert.equal(anonymous.status, 401)
})

test('路径穿越与乱名字一律 404：文件名只认服务端那套形状', async () => {
  // 浏览器/URL 解析会把 .. 折掉，所以这里测的是「折不掉的那一层」：纯函数直接把不合法名字判死
  assert.equal(uploads.safeFileName('../../etc/passwd'), '')
  assert.equal(uploads.safeFileName('x.png'), '')
  assert.equal(uploads.safeFileName('1699999999-abcdef123456.png.tmp'), '')
  assert.equal(uploads.safeFileName('1699999999-abcdef123456.png'), '1699999999-abcdef123456.png')
  assert.equal(uploads.resolveUpload('..', '1699999999-abcdef123456.png'), null)
  assert.equal(uploads.resolveUpload(owner.id, 'x.html'), null)
})

test('张数上限：传满之后顶掉最旧的那张，数量不再涨', async () => {
  const keeper = owner.id
  const originalMax = UPLOAD_LIMITS.maxFiles
  const originalTotal = UPLOAD_LIMITS.maxTotalBytes
  UPLOAD_LIMITS.maxFiles = 3
  UPLOAD_LIMITS.maxTotalBytes = 1024 * MB
  try {
    const made = []
    for (let i = 0; i < 5; i += 1) {
      const saved = await uploads.saveUpload({ userId: keeper, buffer: imageBuffer(PNG_SIGNATURE, 256) })
      made.push(saved)
      // 把 mtime 拉开：同一毫秒内写的几张排序不稳定，顶掉哪张都「对」，但测不出是「最旧的」
      const file = path.join(uploads.uploadsRoot(), keeper, saved.media.split('/').pop())
      const when = new Date(Date.now() - 100000 + i * 1000)
      fs.utimesSync(file, when, when)
    }
    const usage = await uploads.uploadUsage(keeper)
    assert.ok(usage.files <= 3, '最多只剩 3 张，实际 ' + usage.files)
    const oldest = path.join(uploads.uploadsRoot(), keeper, made[0].media.split('/').pop())
    assert.equal(fs.existsSync(oldest), false, '最旧的那张应该被顶掉')
    const newest = path.join(uploads.uploadsRoot(), keeper, made[4].media.split('/').pop())
    assert.equal(fs.existsSync(newest), true, '刚传的这张必须还在')
  } finally {
    UPLOAD_LIMITS.maxFiles = originalMax
    UPLOAD_LIMITS.maxTotalBytes = originalTotal
  }
})

test('最近传的几张：新的在前，路径带自己的账号 id', async () => {
  const list = await call({ method: 'GET', target: '/api/media/uploads?limit=5', cookie: cookieOf(owner) })
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.payload.items))
  assert.ok(list.payload.items.length <= 5)
  for (const item of list.payload.items) assert.match(item.media, new RegExp('^uploads/' + owner.id + '/'))
})
// ---------- 评审入口的归属闸 ----------
// 上传目录按账号分，但评审接口只校验「这张图在数据目录里、是图」，不校验「是不是你的」。
// 这两条用例把归属这一层钉住：别人的图评不了，自己的图不会被误拦。
async function postReview(body, cookie) {
  const router = createReviewRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1/api/review')
  await router.handle(mockReq({ method: 'POST', body: JSON.stringify(body), cookie }), res, url, '/api/review')
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload }
}

test('别人的上传图不能拿来评：404 MEDIA_FORBIDDEN', async () => {
  const saved = await uploads.saveUpload({ userId: other.id, buffer: imageBuffer(PNG_SIGNATURE) })
  const result = await postReview({ media: saved.media, intent: '借别人的图' }, cookieOf(owner))
  assert.equal(result.status, 404)
  assert.equal(result.payload.code, 'MEDIA_FORBIDDEN')
})

test('自己的上传图不会被归属闸拦下', async () => {
  const saved = await uploads.saveUpload({ userId: owner.id, buffer: imageBuffer(PNG_SIGNATURE) })
  const result = await postReview({ media: saved.media, intent: '自己的图' }, cookieOf(owner))
  assert.notEqual(result.payload?.code, 'MEDIA_FORBIDDEN')
})
