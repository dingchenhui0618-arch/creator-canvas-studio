// 模板帧图（v0.9.88）：/media/frames/<模板 id>/<文件名> 以前不校验登录与归属，
// 拿到模板 id 就能把整条片子的抽帧下走。这一组用例把四件事钉住：
// 匿名读不到、别人的私有模板读不到（且不告诉存在性）、主人与管理员读得到、本地演示照常可用。
// 顺带钉住静态目录的路径越界（distFileFor）——同一个上线动作里的另一口。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-frames-'))
process.env.VQ_KEY_SECRET = 'test-secret-frames'
process.env.VQ_REQUIRE_AUTH = '1'

const auth = await import('../server/auth.mjs')
const { config } = await import('../server/config.mjs')
const { createFramesRouter } = await import('../server/routes/frames.mjs')
const { publicTemplateView } = await import('../server/templates.mjs')
const { distFileFor } = await import('../server/static-path.mjs')

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 0x11)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128, 0x22)])

const owner = auth.createUser({ email: '[EMAIL:FRAME-OWNER]', password: 'Passw0rd!demo', name: '模板主人' })
const other = auth.createUser({ email: '[EMAIL:FRAME-OTHER]', password: 'Passw0rd!demo', name: '另一个账号' })
const admin = auth.createUser({ email: '[EMAIL:FRAME-ADMIN]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.7.1' }).token).split(';')[0]

function frameFixture(templateId, names) {
  const dir = path.join(config.framesDir, templateId)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(names)) fs.writeFileSync(path.join(dir, name), bytes)
}

frameFixture('tpl_owner01', { 'frame-01.jpg': JPG })
frameFixture('tpl_public1', { 'frame-01.png': PNG })
// frames 目录里将来多出别的文件（抽帧日志、临时文件）：这条路由只发图片
fs.mkdirSync(path.join(config.framesDir, 'tpl_owner01'), { recursive: true })
fs.writeFileSync(path.join(config.framesDir, 'tpl_owner01', 'notes.txt'), 'internal notes')
fs.writeFileSync(path.join(config.framesDir, 'tpl_owner01', 'frame-01.jpg.tmp'), JPG)

fs.writeFileSync(
  config.templatesFile,
  JSON.stringify([
    {
      id: 'tpl_owner01',
      kind: 'replica',
      title: '只有主人能看的模板',
      ownerId: owner.id,
      frames: [{ index: 1, t: 1.2, url: '/media/frames/tpl_owner01/frame-01.jpg' }],
      storyboard: [{ shotNo: 1, frameIndex: 1, frameUrl: '/media/frames/tpl_owner01/frame-01.jpg' }],
      cover: '/media/frames/tpl_owner01/frame-01.jpg',
    },
    {
      id: 'tpl_public1',
      kind: 'replica',
      title: '公共示例模板',
      ownerId: '',
      shared: true,
      frames: [{ index: 1, t: 0.8, url: '/media/frames/tpl_public1/frame-01.png' }],
      cover: '/media/frames/tpl_public1/frame-01.png',
    },
  ]),
  'utf8',
)

function mockReq({ method = 'GET', cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
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
      this.chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.writableEnded = true
    },
    get text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    get bytes() {
      return Buffer.concat(this.chunks)
    },
  }
}

async function get(target, { cookie = '', method = 'GET' } = {}) {
  const router = createFramesRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  const handled = await router.handle(mockReq({ method, cookie }), res, url, url.pathname)
  return { handled, status: res.statusCode, res }
}

test('匿名读模板帧：401，一个字节都不给', async () => {
  const result = await get('/media/frames/tpl_owner01/frame-01.jpg')
  assert.equal(result.handled, true)
  assert.equal(result.status, 401)
  const payload = JSON.parse(result.res.text)
  assert.equal(payload.loginRequired, true)
  assert.equal(result.res.chunks.length <= 1, true)
  assert.equal(result.res.bytes.includes(0x11), false, '响应体里不该有图片字节')
})

test('主人读自己的帧：200，字节一致，private 缓存 + nosniff', async () => {
  const result = await get('/media/frames/tpl_owner01/frame-01.jpg', { cookie: cookieOf(owner) })
  assert.equal(result.status, 200)
  assert.equal(result.res.headers['Content-Type'], 'image/jpeg')
  assert.equal(result.res.headers['Content-Length'], JPG.length)
  assert.match(result.res.headers['Cache-Control'], /^private/)
  assert.equal(result.res.headers['X-Content-Type-Options'], 'nosniff')
  assert.deepEqual(result.res.bytes, JPG)
})

test('别人的私有模板：404，连「这个 id 存在」都不告诉', async () => {
  const result = await get('/media/frames/tpl_owner01/frame-01.jpg', { cookie: cookieOf(other) })
  assert.equal(result.status, 404)
  assert.equal(result.res.text, 'frame not found')
  // 与「模板根本不存在」同一个响应：两种情况的答案必须一模一样
  const missing = await get('/media/frames/tpl_nosuch01/frame-01.jpg', { cookie: cookieOf(other) })
  assert.equal(missing.status, 404)
  assert.equal(missing.res.text, result.res.text)
})

test('管理员排障能看全部；公共模板（没有归属）谁都看得见', async () => {
  const asAdmin = await get('/media/frames/tpl_owner01/frame-01.jpg', { cookie: cookieOf(admin) })
  assert.equal(asAdmin.status, 200)
  assert.deepEqual(asAdmin.res.bytes, JPG)

  const asOther = await get('/media/frames/tpl_public1/frame-01.png', { cookie: cookieOf(other) })
  assert.equal(asOther.status, 200)
  assert.equal(asOther.res.headers['Content-Type'], 'image/png')
  assert.deepEqual(asOther.res.bytes, PNG)
})

test('只发图片：frames 目录里的 txt / 临时文件一律 404', async () => {
  const notes = await get('/media/frames/tpl_owner01/notes.txt', { cookie: cookieOf(owner) })
  assert.equal(notes.status, 404)
  const tmp = await get('/media/frames/tpl_owner01/frame-01.jpg.tmp', { cookie: cookieOf(owner) })
  assert.equal(tmp.status, 404)
})

test('模板不在库里的孤儿帧：404（模板彻底删掉后，帧文件也不该还能读）', async () => {
  frameFixture('tpl_orphan1', { 'frame-01.jpg': JPG })
  const result = await get('/media/frames/tpl_orphan1/frame-01.jpg', { cookie: cookieOf(owner) })
  assert.equal(result.status, 404)
})

test('路径形状不认的直接放行给后面的 404，不在这里猜', async () => {
  // decodeURIComponent 之后带 / 的（../templates.json）不匹配这条路由的模板 id/文件名
  const result = await get('/media/frames/tpl_owner01/%2e%2e%2ftemplates.json')
  assert.equal(result.handled, false)
})

test('只支持 GET：POST 回 405 并带 Allow', async () => {
  const result = await get('/media/frames/tpl_owner01/frame-01.jpg', { cookie: cookieOf(owner), method: 'POST' })
  assert.equal(result.status, 405)
  assert.equal(result.res.headers.Allow, 'GET')
})

test('本地演示（VQ_REQUIRE_AUTH=0）匿名照常能看：离线开发不该被自己挡住', async () => {
  const original = config.auth.requireAuth
  config.auth.requireAuth = false
  try {
    const result = await get('/media/frames/tpl_owner01/frame-01.jpg')
    assert.equal(result.status, 200)
    assert.deepEqual(result.res.bytes, JPG)
  } finally {
    config.auth.requireAuth = original
  }
})

test('分享页不靠这条路由：公开视图里的帧图全是带 token 的地址', () => {
  const view = publicTemplateView(
    {
      id: 'tpl_owner01',
      frames: [{ index: 1, t: 1.2, url: '/media/frames/tpl_owner01/frame-01.jpg' }],
      storyboard: [{ shotNo: 1, frameIndex: 1, frameUrl: '/media/frames/tpl_owner01/frame-01.jpg' }],
      cover: '/media/frames/tpl_owner01/frame-01.jpg',
    },
    'tok_0123456789abcdef',
  )
  assert.equal(view.frames[0].url, '/api/share/tok_0123456789abcdef/frame/1')
  assert.equal(view.storyboard[0].frameUrl, '/api/share/tok_0123456789abcdef/frame/1')
  assert.equal(view.cover, '/api/share/tok_0123456789abcdef/cover')
  assert.equal(JSON.stringify(view).includes('/media/frames'), false, '分享页的 JSON 里不能出现要登录的帧图地址')
})

// ---------- 静态目录的路径越界 ----------
test('dist 路径越界：.. / 反斜杠 / 多级 都回空串，正常静态资源照常解析', () => {
  const root = path.resolve(os.tmpdir(), 'vq-dist-root')
  assert.equal(distFileFor(root, '/index.html'), path.join(root, 'index.html'))
  assert.equal(distFileFor(root, '/assets/app-abc123.js'), path.join(root, 'assets', 'app-abc123.js'))
  assert.equal(distFileFor(root, '/../package.json'), '')
  assert.equal(distFileFor(root, '/..\\package.json'), '')
  assert.equal(distFileFor(root, '/../../etc/passwd'), '')
  assert.equal(distFileFor(root, '/assets/../../package.json'), '')
  // 根目录本身是「没有文件」，由调用方决定回 index.html
  assert.equal(distFileFor(root, '/'), root)
})
