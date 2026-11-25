// 头像（r313）：文件头校验、2 MB 上限、版本号、本人/管理员可读、别人 404。
// 全程只在临时 DATA_DIR 里跑，不连真实上游、不读生产账号。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-avatar-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-avatar'
process.env.VQ_REQUIRE_AUTH = '1'

const auth = await import('../server/auth.mjs')
const avatars = await import('../server/avatar.mjs')
const { createAccountRouter } = await import('../server/routes/account.mjs')

const MB = 1024 * 1024
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
  Buffer.alloc(128, 0x20),
])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 0x20)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.alloc(128, 0x20)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(128, 0x20)])

const owner = auth.createUser({ email: '[EMAIL:AVATAR1]', password: 'Passw0rd!demo', name: '头像用户', kind: 'account' })
const other = auth.createUser({ email: '[EMAIL:AVATAR2]', password: 'Passw0rd!demo', name: '另一个用户', kind: 'account' })
const admin = auth.createUser({ email: '[EMAIL:AVATAR3]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })

const cookieOf = (user) => auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '127.0.0.1' }).token).split(';')[0]

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
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.writableEnded = true
    },
    get buffer() {
      return Buffer.concat(this.chunks)
    },
    get body() {
      return this.buffer.toString('utf8')
    },
  }
}

async function call({ method = 'GET', target = '/api/account/avatar/' + owner.id, body = null, cookie = '', headers = {} } = {}) {
  const router = createAccountRouter()
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + target)
  await router.handle(mockReq({ method, body, cookie, headers }), res, url, url.pathname)
  let payload = null
  try { payload = JSON.parse(res.body) } catch { payload = null }
  return { status: res.statusCode, payload, res }
}

async function multipart(buffer, { filename = 'avatar.png', mime = 'image/png', field = 'avatar' } = {}) {
  const form = new FormData()
  form.append(field, new Blob([buffer], { type: mime }), filename)
  const request = new Request('http://127.0.0.1/api/account/avatar', { method: 'POST', body: form })
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type') || '',
  }
}

test('users 表有 avatar_version；没有头像时 avatarUrl 是空串', () => {
  const columns = auth.openDb().prepare('PRAGMA table_info(users)').all()
  assert.ok(columns.some((column) => column.name === 'avatar_version'))
  assert.equal(auth.publicUser(owner).avatarUrl, '')
  assert.equal(auth.avatarUrlFor(owner.id, ''), '')
  assert.match(auth.avatarUrlFor(owner.id, 'v1'), /^\/api\/account\/avatar\/.+\?v=v1$/)
})

test('PNG / JPEG / WebP 按文件头认；GIF、HTML 与超大文件拒收', async () => {
  const png = await avatars.saveAvatar(owner.id, PNG, 'image/png')
  assert.equal(png.has, true)
  assert.ok(png.version)
  assert.equal(auth.publicUser(auth.findUserById(owner.id)).avatarUrl, png.url)
  assert.ok(fs.existsSync(path.join(dir, 'avatars', owner.id + '.png')))

  const jpg = await avatars.saveAvatar(owner.id, JPG, 'image/jpeg')
  assert.equal(jpg.has, true)
  assert.notEqual(jpg.version, png.version, '换图必须换版本号')
  assert.ok(fs.existsSync(path.join(dir, 'avatars', owner.id + '.jpg')))
  assert.equal(fs.existsSync(path.join(dir, 'avatars', owner.id + '.png')), false, '换格式后旧扩展名要清掉')

  const webp = await avatars.saveAvatar(owner.id, WEBP, 'image/webp')
  assert.equal(webp.has, true)
  assert.ok(fs.existsSync(path.join(dir, 'avatars', owner.id + '.webp')))

  await assert.rejects(
    () => avatars.saveAvatar(owner.id, GIF, 'image/gif'),
    (error) => error.status === 415 && error.code === 'AVATAR_TYPE',
  )
  await assert.rejects(
    () => avatars.saveAvatar(owner.id, Buffer.from('<html>not an image</html>'), 'image/png'),
    (error) => error.status === 415 && error.code === 'AVATAR_TYPE',
  )
  const huge = Buffer.concat([PNG, Buffer.alloc(2 * MB)])
  await assert.rejects(
    () => avatars.saveAvatar(owner.id, huge, 'image/png'),
    (error) => error.status === 413 && error.code === 'AVATAR_TOO_LARGE',
  )
})

test('删除头像：文件和版本一起清，再读是空', async () => {
  await avatars.saveAvatar(owner.id, PNG, 'image/png')
  assert.equal(await avatars.removeAvatar(owner.id), true)
  assert.equal(await avatars.removeAvatar(owner.id), false, '本来就没有时返回 false')
  const view = await avatars.avatarView(owner.id)
  assert.deepEqual(view, { has: false, url: '', version: '' })
  assert.equal(fs.existsSync(path.join(dir, 'avatars', owner.id + '.png')), false)
  assert.equal(auth.publicUser(auth.findUserById(owner.id)).avatarUrl, '')
})

test('读头像：本人 200、管理员 200、别人 404、未登录 401', async () => {
  await avatars.saveAvatar(owner.id, PNG, 'image/png')
  const mine = await call({ cookie: cookieOf(owner) })
  assert.equal(mine.status, 200)
  assert.equal(mine.res.headers['Content-Type'], 'image/png')
  assert.equal(mine.res.headers['X-Content-Type-Options'], 'nosniff')
  assert.ok(mine.res.buffer.subarray(0, 8).equals(PNG.subarray(0, 8)))

  const boss = await call({ cookie: cookieOf(admin) })
  assert.equal(boss.status, 200)

  const stranger = await call({ cookie: cookieOf(other) })
  assert.equal(stranger.status, 404, '不能告诉别人这个账号有没有头像')

  const anonymous = await call({})
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.payload.loginRequired, true)

  const missing = await call({ target: '/api/account/avatar/usr_missing', cookie: cookieOf(admin) })
  assert.equal(missing.status, 404)
})

test('POST /api/account/avatar 收 multipart 单文件；GET 能读回；DELETE 清掉', async () => {
  const form = await multipart(PNG)
  const uploaded = await call({
    method: 'POST',
    target: '/api/account/avatar',
    body: form.body,
    cookie: cookieOf(owner),
    headers: { 'content-type': form.contentType },
  })
  assert.equal(uploaded.status, 200)
  assert.equal(uploaded.payload.ok, true)
  assert.equal(uploaded.payload.avatar.has, true)
  assert.match(uploaded.payload.avatar.url, /^\/api\/account\/avatar\//)

  const pathname = new URL('http://127.0.0.1' + uploaded.payload.avatar.url).pathname
  const read = await call({ target: pathname, cookie: cookieOf(owner) })
  assert.equal(read.status, 200)
  assert.equal(read.res.headers['Content-Type'], 'image/png')

  const removed = await call({ method: 'DELETE', target: '/api/account/avatar', cookie: cookieOf(owner) })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.payload.avatar, { has: false, url: '', version: '' })

  const gone = await call({ target: pathname, cookie: cookieOf(owner) })
  assert.equal(gone.status, 404)
})

test('上传边界：非 multipart 400、缺字段 400、GIF 415、声明太大 413', async () => {
  const wrongType = await call({
    method: 'POST',
    target: '/api/account/avatar',
    body: Buffer.from('{}'),
    cookie: cookieOf(owner),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(wrongType.status, 400)

  const form = await multipart(PNG, { field: 'file' })
  const missing = await call({
    method: 'POST',
    target: '/api/account/avatar',
    body: form.body,
    cookie: cookieOf(owner),
    headers: { 'content-type': form.contentType },
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.payload.code, 'AVATAR_FILE_REQUIRED')

  const gifForm = await multipart(GIF, { mime: 'image/gif' })
  const gif = await call({
    method: 'POST',
    target: '/api/account/avatar',
    body: gifForm.body,
    cookie: cookieOf(owner),
    headers: { 'content-type': gifForm.contentType },
  })
  assert.equal(gif.status, 415)
  assert.equal(gif.payload.code, 'AVATAR_TYPE')

  const tooBig = await call({
    method: 'POST',
    target: '/api/account/avatar',
    body: Buffer.alloc(16),
    cookie: cookieOf(owner),
    headers: {
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(3 * MB),
    },
  })
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.payload.code, 'AVATAR_TOO_LARGE')
})
