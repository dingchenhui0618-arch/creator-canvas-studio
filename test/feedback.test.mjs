import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 应用内反馈（B5）：这一组盯住六条——
//   1) 匿名提交必须有联系方式，体长与类型都有边界；
//   2) 落盘、计数、按状态筛选，重启不丢（读的是同一份 feedback.json）；
//   3) 同一账号十分钟内重复提交只算一条；
//   4) 「我的反馈」只回本账号，管理员回复能回到提交者；
//   5) 路由层：匿名可提交、读自己的要登录、管理后台要管理员；
//   6) 公开入口在限流表里。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-feedback-'))
process.env.VQ_KEY_SECRET = 'test-secret-feedback'

const auth = await import('../server/auth.mjs')
const feedback = await import('../server/feedback.mjs')
const rate = await import('../server/ratelimit.mjs')
const { createFeedbackRouter } = await import('../server/routes/feedback.mjs')
const { createAdminRouter } = await import('../server/routes/admin.mjs')

const admin = auth.createUser({ email: 'feedback-admin@example.test', password: 'Passw0rd!demo', name: '反馈管理员', kind: 'admin' })
const alice = auth.createUser({ email: 'feedback-alice@example.test', password: 'Passw0rd!demo', name: '反馈用户', kind: 'user' })
const bob = auth.createUser({ email: 'feedback-bob@example.test', password: 'Passw0rd!demo', name: '另一个用户', kind: 'user' })

function mockReq({ method = 'POST', body = null, cookie = '', headers = {} } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { ...(cookie ? { cookie } : {}), ...headers }
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

const cookieOf = (user) => auth.sessionCookie(auth.createSession(user).token).split(';')[0]

test('匿名提交必须留联系方式，文字太短也不行', async () => {
  const noContact = await feedback.createFeedback({ kind: 'problem', body: '登录页一直转圈进不去', ip: '10.0.0.1' })
  assert.equal(noContact.ok, false)
  assert.equal(noContact.code, 'CONTACT_REQUIRED')

  const tooShort = await feedback.createFeedback({ kind: 'problem', body: '坏了', contact: 'help@example.test', ip: '10.0.0.2' })
  assert.equal(tooShort.ok, false)
  assert.equal(tooShort.code, 'BODY_TOO_SHORT')

  const ok = await feedback.createFeedback({ kind: 'problem', body: '登录页一直转圈进不去', contact: 'help@example.test', ip: '10.0.0.3' })
  assert.equal(ok.ok, true)
  assert.match(ok.item.id, /^fb_[0-9a-f]{8}$/)
  assert.equal(ok.item.contact, 'help@example.test')
  assert.equal(ok.item.status, 'new')
})

test('落盘、计数与状态筛选：重启后读同一份文件', async () => {
  const created = await feedback.createFeedback({ kind: 'idea', body: '希望画布能一键导出成 PDF', user: alice, ip: '10.0.0.4' })
  assert.equal(created.ok, true)
  // 未知类型归到「其他」，不把脏值写进队列
  const messy = await feedback.createFeedback({ kind: 'not-a-kind', body: '顺手提一句：模板库的筛选挺好用', user: bob, ip: '10.0.0.5' })
  assert.equal(messy.item.kind, 'other')

  const open = await feedback.listFeedback({ status: 'new' })
  assert.ok(open.items.length >= 3)
  assert.ok(open.counts.new >= 3)
  assert.equal(open.counts.total, open.counts.new + open.counts.reading + open.counts.done)

  const file = path.join(process.env.DATA_DIR, 'feedback.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(stored))
  assert.ok(stored.some((item) => item.id === created.item.id))
  assert.ok(stored.every((item) => item.status === 'new'))
})

test('同一账号十分钟内重复提交只算一条，双击不刷队列', async () => {
  const before = (await feedback.listFeedback({ status: 'all' })).counts.total
  const first = await feedback.createFeedback({ kind: 'other', body: '重复提交这一句看看会不会合并', user: bob, ip: '10.0.0.6' })
  const second = await feedback.createFeedback({ kind: 'other', body: '重复提交这一句看看会不会合并', user: bob, ip: '10.0.0.6' })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(second.item.id, first.item.id)
  assert.equal((await feedback.listFeedback({ status: 'all' })).counts.total, before + 1)
})

test('我的反馈只回本账号，管理员回复回到提交者', async () => {
  const created = await feedback.createFeedback({ kind: 'problem', body: '画布里的视频节点点不动，能不能修一下', user: alice, ip: '10.0.0.7' })
  const mine = await feedback.listMyFeedback(alice.id, 20)
  assert.ok(mine.some((item) => item.id === created.item.id))
  assert.ok(mine.every((item) => item.userId === alice.id))
  assert.equal((await feedback.listMyFeedback(bob.id, 20)).some((item) => item.id === created.item.id), false)

  const done = await feedback.updateFeedback(created.item.id, { status: 'done', reply: '已修，下个版本画布视频可以直接播放', by: admin.email })
  assert.equal(done.ok, true)
  assert.equal(done.item.status, 'done')
  assert.ok(done.item.resolvedAt)
  assert.equal(done.item.handledBy, admin.email)

  const after = await feedback.listMyFeedback(alice.id, 20)
  const row = after.find((item) => item.id === created.item.id)
  assert.equal(row.status, 'done')
  assert.match(row.reply, /下个版本/)

  const bad = await feedback.updateFeedback(created.item.id, { status: 'whatever' })
  assert.equal(bad.code, 'BAD_STATUS')
  const missing = await feedback.updateFeedback('fb_00000000', { status: 'done' })
  assert.equal(missing.code, 'NOT_FOUND')
})

test('路由：匿名可提交，读自己的要登录', async () => {
  const router = createFeedbackRouter()
  const target = '/api/feedback'
  const res = mockRes()
  const handled = await router.handle(
    mockReq({ body: { kind: 'problem', body: '登录进不来，忘记口令也收不到邮件', contact: 'anon@example.test', page: '#/login' } }),
    res,
    new URL('http://127.0.0.1' + target),
    target,
  )
  assert.equal(handled, true)
  assert.equal(res.statusCode, 201)
  const payload = JSON.parse(res.body)
  assert.match(payload.id, /^fb_/)
  assert.equal(payload.status, 'new')

  const noContact = mockRes()
  await router.handle(
    mockReq({ body: { kind: 'problem', body: '匿名但没留联系方式的一条反馈' } }),
    noContact,
    new URL('http://127.0.0.1' + target),
    target,
  )
  assert.equal(noContact.statusCode, 400)
  assert.equal(JSON.parse(noContact.body).field, 'contact')

  const anonymousMine = mockRes()
  await router.handle(mockReq({ method: 'GET' }), anonymousMine, new URL('http://127.0.0.1' + target + '/mine'), target + '/mine')
  assert.equal(anonymousMine.statusCode, 401)

  const mineRes = mockRes()
  await router.handle(
    mockReq({ method: 'GET', cookie: cookieOf(alice) }),
    mineRes,
    new URL('http://127.0.0.1' + target + '/mine'),
    target + '/mine',
  )
  assert.equal(mineRes.statusCode, 200)
  const mine = JSON.parse(mineRes.body)
  assert.ok(mine.items.length >= 1)
  // 只回展示需要的字段：IP / UA / 处理人这些内部信息不下发给普通用户
  assert.ok(mine.items.every((item) => !('ip' in item) && !('ua' in item) && !('handledBy' in item)))
  const ownIds = new Set((await feedback.listMyFeedback(alice.id, 20)).map((item) => item.id))
  assert.ok(mine.items.every((item) => ownIds.has(item.id)))
})

test('后台：管理员能看队列、改状态、写回复；普通账号被挡', async () => {
  const router = createAdminRouter()
  const target = '/api/admin/feedback'

  const forbidden = mockRes()
  await router.handle(mockReq({ method: 'GET', cookie: cookieOf(bob) }), forbidden, new URL('http://127.0.0.1' + target), target)
  assert.equal(forbidden.statusCode, 403)

  const listRes = mockRes()
  await router.handle(mockReq({ method: 'GET', cookie: cookieOf(admin) }), listRes, new URL('http://127.0.0.1' + target + '?status=all'), target)
  assert.equal(listRes.statusCode, 200)
  const queue = JSON.parse(listRes.body)
  assert.ok(queue.items.length >= 1)
  assert.ok(queue.counts.total >= 1)

  const targetId = queue.items[0].id
  const updateRes = mockRes()
  const path = target + '/' + targetId
  await router.handle(
    mockReq({ cookie: cookieOf(admin), body: { status: 'reading', reply: '已经在看了' } }),
    updateRes,
    new URL('http://127.0.0.1' + path),
    path,
  )
  assert.equal(updateRes.statusCode, 200)
  const updated = JSON.parse(updateRes.body)
  assert.equal(updated.item.status, 'reading')
  assert.equal(updated.item.reply, '已经在看了')
  assert.ok(updated.counts.reading >= 1)
})

test('公开反馈入口在限流表里（按 IP 每分钟 3 条）', () => {
  const rule = rate.rateLimitRules().find((item) => item.bucket === 'feedback')
  assert.ok(rule, '没有限流规则，公开接口会被脚本刷')
  assert.equal(rule.method, 'POST')
  assert.equal(rule.limit, 3)
})
