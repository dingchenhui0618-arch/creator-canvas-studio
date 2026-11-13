// 评审缩图的路由级验收（v0.9.74）：进来的图 3 MB，真正发给模型的必须是缩过的那一份。
// 纯函数测不到这件事——要有人在中间把「发给上游的请求体」接住看。
// 用一个本地假上游顶替模型：它只回答固定 JSON，顺便把 image_url 的长度记下来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import ffmpegPath from 'ffmpeg-static'

const run = promisify(execFile)
const MB = 1024 * 1024

// 假上游先起来，拿到端口再让 config 读环境变量（config 是导入时求值的）
const seen = []
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try { seen.push(JSON.parse(body)) } catch { seen.push(null) }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: 'pass',
            summary: '固定结论：缩图不影响这次验收',
            observations: [],
            fixes: [],
            notAssessable: [],
          }),
        },
      }],
    }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const port = upstream.address().port
test.after(() => upstream.close())

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-compress-'))
process.env.VQ_KEY_SECRET = 'test-secret-review-compress'
process.env.VISION_BASE_URL = 'http://127.0.0.1:' + port + '/v1'
process.env.VISION_API_KEY = 'test-key-not-real'
process.env.VISION_MODEL = 'fake-vision'

const { config } = await import('../server/config.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const { createReviewRouter } = await import('../server/routes/review.mjs')

const me = auth.createUser({ email: '[EMAIL:RC1]', password: 'Passw0rd!demo', name: '缩图用例' })
const cookie = auth.sessionCookie(auth.createSession(me, { userAgent: 'test', ip: '10.0.6.1' }).token).split(';')[0]
const balance = () => credits.balanceOf(me.id)

const mediaDir = path.join(config.dataDir, 'media')
fs.mkdirSync(mediaDir, { recursive: true })

function mockReq(body) {
  const req = new Readable({ read() {} })
  req.method = 'POST'
  req.headers = { cookie }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[name] = value },
    write(chunk) { this.body += String(chunk); return true },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableEnded = true },
  }
}

async function postReview(body) {
  const router = createReviewRouter()
  const res = mockRes()
  const target = '/api/review'
  await router.handle(mockReq(body), res, new URL('http://127.0.0.1' + target), target)
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload }
}

test('3 MB 的图：发给模型的是缩过的 JPEG，结论照旧落库', async (t) => {
  // 造一张 2400x1400 的真图再补到 3 MB：与压测里「大图」同一类输入
  const source = path.join(mediaDir, 'big.jpg')
  try {
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=2400x1400:rate=1', '-frames:v', '1', '-q:v', '2', source], { maxBuffer: 4 * MB })
  } catch (error) {
    t.skip('本机没有可用的 ffmpeg：' + String(error?.message || error).slice(0, 80))
    return
  }
  const core = fs.readFileSync(source)
  fs.writeFileSync(source, Buffer.concat([core, Buffer.alloc(Math.max(0, 3 * MB - core.length))]))
  const before = balance()
  const result = await postReview({ media: 'media/big.jpg', intent: '缩图验收' })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.compression?.applied, true)
  assert.equal(result.payload.compression.originalBytes, 3 * MB)
  assert.ok(result.payload.compression.sentBytes < 512 * 1024, '送审字节应该只剩几百 KB，实际 ' + result.payload.compression.sentBytes)
  assert.equal(result.payload.verdict, 'pass')
  assert.equal(balance(), before - 5, '一次评审扣 5 积分')

  // 假上游收到的 image_url 必须是缩过的那份，不是原图
  const chat = seen.filter((item) => item && Array.isArray(item.messages)).pop()
  assert.ok(chat, '没有抓到发往模型的请求')
  const parts = chat.messages.at(-1).content
  const image = parts.find((part) => part.type === 'image_url')
  assert.ok(image, '请求里没有图')
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/)
  assert.ok(image.image_url.url.length < 700 * 1024, '发给模型的 data URL 应该只有几百 KB，实际 ' + image.image_url.url.length)
})
