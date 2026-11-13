// 素材占用上限（v0.9.68）。这一组盯住五件事：
//   1) 默认不限：没定数字之前不设死，任务照常接；
//   2) 口径只算自己的模板：公共示例不记在任何账号头上，别人占的盘不算我的；
//   3) 到顶就拒：429 的原因里要说清「删模板」与「找管理员放宽」，免费（未登录）不受限；
//   4) 孤立帧图只清「没有模板指向」的目录，活着的模板一张图都不动；
//   5) 后台可改：坏输入 400、清不存在的覆盖 404、非管理员 403，改动进审计。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-storage-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-storage'

const auth = await import('../server/auth.mjs')
const storage = await import('../server/storage.mjs')
const { listAudit } = await import('../server/audit.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')
const { createStorageRouter } = await import('../server/routes/storage.mjs')

const MB = 1024 * 1024
const admin = auth.createUser({ email: '[EMAIL:ADMIN2]', password: 'Passw0rd!demo', name: '管理员', kind: 'admin' })
const alice = auth.createUser({ email: '[EMAIL:USER4]', password: 'Passw0rd!demo', name: '阿栗', kind: 'user' })
const bob = auth.createUser({ email: '[EMAIL:USER5]', password: 'Passw0rd!demo', name: '小博', kind: 'user' })

const adminCookie = auth.sessionCookie(auth.createSession(admin, { userAgent: 'test', ip: '10.0.2.1' }).token).split(';')[0]
const aliceCookie = auth.sessionCookie(auth.createSession(alice, { userAgent: 'test', ip: '10.0.2.2' }).token).split(';')[0]

const framesDir = path.join(dataDir, 'frames')
function frameDir(id, bytes, perFile = 1) {
  fs.mkdirSync(path.join(framesDir, id), { recursive: true })
  for (let i = 0; i < perFile; i += 1) {
    fs.writeFileSync(path.join(framesDir, id, 'frame-' + String(i + 1).padStart(2, '0') + '.jpg'), Buffer.alloc(Math.ceil(bytes / perFile)))
  }
}
frameDir('tpl_alice1', 2 * MB + 8192, 4)
frameDir('tpl_bob1', 4096, 1)
frameDir('tpl_shared1', 512 * 1024, 1)

fs.writeFileSync(
  path.join(dataDir, 'templates.json'),
  JSON.stringify([
    { id: 'tpl_alice1', title: '阿栗的模板', ownerId: alice.id, frames: [] },
    { id: 'tpl_bob1', title: '小博的模板', ownerId: bob.id, frames: [] },
    { id: 'tpl_shared1', title: '官方示例', ownerId: '', shared: true, frames: [] },
  ]),
)

function mockReq({ method = 'GET', body = null, cookie = '' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = cookie ? { cookie } : {}
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

const call = async (router, req, pathname) => {
  const res = mockRes()
  await router.handle(req, res, new URL('http://127.0.0.1' + pathname), pathname)
  return res
}

test('默认不限：没有数字之前不设死，自己的占用照实算', async () => {
  const view = await storage.storageOf(alice.id)
  assert.equal(view.unlimited, true)
  assert.equal(view.limitMb, 0)
  assert.equal(view.remainingBytes, null)
  assert.equal(view.over, false)
  assert.equal(view.percent, null)
  assert.ok(view.bytes > 2 * MB, '阿栗自己的帧图要算进占用')
  const room = await storage.storageRoom(alice.id)
  assert.equal(room.ok, true)
})

test('口径：公共示例不算任何人的，别人占的盘也不算我的', async () => {
  const overview = await storage.storageOverview()
  const aliceRow = overview.accounts.find((row) => row.userId === alice.id)
  const bobRow = overview.accounts.find((row) => row.userId === bob.id)
  assert.ok(aliceRow.bytes > 2 * MB)
  assert.equal(bobRow.bytes, 4096)
  assert.equal(aliceRow.templates, 1)
  assert.equal(overview.shared.bytes, 512 * 1024)
  assert.equal(overview.frames.dirs, 3)
  assert.equal(overview.orphans.count, 0)
})

test('到顶就拒：429 要说清删模板与找管理员，别人的上限不影响我', async () => {
  const saved = storage.saveStorageLimit(1, 'admin@test')
  assert.equal(saved.ok, true)
  const view = await storage.storageOf(alice.id)
  assert.equal(view.over, true)
  assert.equal(view.limitMb, 1)
  const room = await storage.storageRoom(alice.id)
  assert.equal(room.ok, false)
  assert.equal(room.code, 'STORAGE_LIMIT')
  assert.match(room.message, /素材占用已到上限/)
  assert.match(room.message, /删掉不用的模板/)
  assert.match(room.message, /素材占用上限/)
  // 小博只有 4 KB，同一档默认上限下不受影响
  const bobRoom = await storage.storageRoom(bob.id)
  assert.equal(bobRoom.ok, true)
})

test('按账号覆盖：0 表示这个账号不限，清掉后回到默认', async () => {
  const set = storage.setStorageOverride(bob.id, 0, 'admin@test')
  assert.equal(set.ok, true)
  const bobView = await storage.storageOf(bob.id)
  assert.equal(bobView.unlimited, true)
  assert.equal(bobView.overridden, true)
  const cleared = storage.clearStorageOverride(bob.id)
  assert.equal(cleared.ok, true)
  const back = await storage.storageOf(bob.id)
  assert.equal(back.unlimited, false)
  assert.equal(back.limitMb, 1)
  assert.equal(storage.clearStorageOverride(bob.id).code, 'NOT_FOUND')
})

test('坏输入一律拒绝：负数、小数、超大、不存在账号', () => {
  assert.equal(storage.saveStorageLimit(-1, 'a').ok, false)
  assert.equal(storage.saveStorageLimit(1.5, 'a').ok, false)
  assert.equal(storage.saveStorageLimit('abc', 'a').ok, false)
  assert.equal(storage.saveStorageLimit(2 * 1024 * 1024, 'a').ok, false)
  assert.equal(storage.setStorageOverride('nobody', 10, 'a').code, 'NOT_FOUND')
  assert.equal(storage.setStorageOverride(bob.id, -5, 'a').ok, false)
})

test('上限文件是 0600：能由服务端读写，别人不该顺手拿到', () => {
  const file = path.join(dataDir, 'storage-limits.json')
  storage.saveStorageLimit(3, 'admin@test')
  // Windows 上 chmod 只是个只读位，权限断言只在 POSIX 上有意义
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(storage.storageLimits().defaultMb, 3)
})

test('孤立帧图：只清没有模板指向的目录，活着的模板一张图都不动', async () => {
  frameDir('tpl_dead0001', 64 * 1024, 1)
  const before = await storage.storageOverview()
  assert.equal(before.orphans.count, 1)
  assert.equal(before.orphans.ids[0], 'tpl_dead0001')
  const cleaned = await storage.cleanOrphanFrames()
  assert.equal(cleaned.dirs, 1)
  assert.ok(cleaned.bytes > 0)
  assert.equal(fs.existsSync(path.join(framesDir, 'tpl_dead0001')), false)
  assert.equal(fs.existsSync(path.join(framesDir, 'tpl_alice1')), true)
  const after = await storage.storageOverview()
  assert.equal(after.orphans.count, 0)
})

test('后台接口：非管理员 403，管理员能读、能改、能清理，改动进审计', async () => {
  const router = createAdminRouter()
  const denied = await call(router, mockReq({ cookie: aliceCookie }), '/api/admin/storage')
  assert.equal(denied.statusCode, 403)

  const read = await call(router, mockReq({ cookie: adminCookie }), '/api/admin/storage')
  assert.equal(read.statusCode, 200)
  const payload = JSON.parse(read.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.bytes > 0, '磁盘总量仍然照常回')
  assert.ok(payload.frames.bytes > 0)
  assert.ok(Array.isArray(payload.accounts))
  assert.equal(typeof payload.limits.defaultMb, 'number')

  const put = await call(router, mockReq({ method: 'PUT', cookie: adminCookie, body: { defaultMb: 2 } }), '/api/admin/storage')
  assert.equal(put.statusCode, 200)
  assert.equal(JSON.parse(put.body).limits.defaultMb, 2)

  const bad = await call(router, mockReq({ method: 'PUT', cookie: adminCookie, body: { defaultMb: -9 } }), '/api/admin/storage')
  assert.equal(bad.statusCode, 400)

  const override = await call(router, mockReq({ method: 'PUT', cookie: adminCookie, body: { limitMb: 0 } }), '/api/admin/storage/overrides/' + alice.id)
  assert.equal(override.statusCode, 200)
  assert.equal(JSON.parse(override.body).limits.overrides[alice.id], 0)

  const drop = await call(router, mockReq({ method: 'DELETE', cookie: adminCookie }), '/api/admin/storage/overrides/' + alice.id)
  assert.equal(drop.statusCode, 200)
  assert.equal(JSON.parse(drop.body).limits.overrides[alice.id], undefined)

  const clean = await call(router, mockReq({ method: 'POST', cookie: adminCookie, body: {} }), '/api/admin/storage/clean')
  assert.equal(clean.statusCode, 200)

  const actions = listAudit({ limit: 50 }).items.map((row) => row.action)
  assert.ok(actions.includes('storage.save'), '改上限要进审计')
})

test('用户接口：只看得到自己的占用，未登录 401', async () => {
  const router = createStorageRouter()
  const denied = await call(router, mockReq({}), '/api/storage')
  assert.equal(denied.statusCode, 401)

  const mine = await call(router, mockReq({ cookie: aliceCookie }), '/api/storage')
  assert.equal(mine.statusCode, 200)
  const payload = JSON.parse(mine.body)
  assert.equal(payload.ok, true)
  assert.ok(payload.bytes > 2 * MB)
  // 不在用户接口里泄露别人的占用与磁盘总量
  assert.equal(payload.accounts, undefined)
  assert.equal(payload.disk, undefined)
})
